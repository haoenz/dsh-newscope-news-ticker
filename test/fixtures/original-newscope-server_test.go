package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/umputun/newscope/pkg/config"
	"github.com/umputun/newscope/pkg/repository"
	"github.com/umputun/newscope/server/mocks"
)

// Copy this test-only fixture into the unmodified upstream 9c02bfa checkout server/ directory.
// It uses the real original RSS/HTML handlers, an in-memory DB and no scheduler.
// No new JSON articles API is installed.
// TestTickerBrowserAcceptanceServer exposes an opt-in, isolated backend for browser acceptance.
// DSH_TICKER_QA_PORT=8082 and go test -timeout=0 keep it running until SIGINT/SIGTERM.
func TestTickerBrowserAcceptanceServer(t *testing.T) {
	port := os.Getenv("DSH_TICKER_QA_PORT")
	if port == "" {
		t.Skip("set DSH_TICKER_QA_PORT=8082 to run the isolated browser acceptance backend")
	}
	require.Equal(t, "8082", port, "acceptance backend must never bind a production port")
	repos, err := repository.NewRepositories(context.Background(), repository.Config{
		DSN: ":memory:", MaxOpenConns: 1, MaxIdleConns: 1,
	})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, repos.Close()) })
	_, err = repos.DB.Exec("INSERT INTO feeds (id, url, title, enabled) VALUES (1, ?, ?, 0)",
		"https://ticker-qa.invalid/feed", "独立浏览器验收源")
	require.NoError(t, err)

	cfg := &config.Config{}
	cfg.Server.BaseURL = "http://127.0.0.1:8082"
	cfg.Server.PageSize = 50
	provider := &mocks.ConfigProviderMock{
		GetFullConfigFunc:   func() *config.Config { return cfg },
		GetServerConfigFunc: func() (string, time.Duration) { return "127.0.0.1:8082", 10 * time.Second },
	}
	forbidden := func(operation string) error {
		t.Errorf("forbidden scheduler call: %s", operation)
		return fmt.Errorf("acceptance scheduler disabled: %s", operation)
	}
	scheduler := &mocks.SchedulerMock{
		UpdateFeedNowFunc:           func(context.Context, int64) error { return forbidden("UpdateFeedNow") },
		ExtractContentNowFunc:       func(context.Context, int64) error { return forbidden("ExtractContentNow") },
		UpdatePreferenceSummaryFunc: func(context.Context) error { return forbidden("UpdatePreferenceSummary") },
		TriggerPreferenceUpdateFunc: func() { _ = forbidden("TriggerPreferenceUpdate") },
	}
	srv := New(provider, NewRepositoryAdapter(repos), scheduler, "ticker-original-acceptance", false)
	qa := &tickerAcceptanceHandler{t: t, repos: repos, router: srv.router, requests: []tickerAcceptanceRequest{}}
	require.NoError(t, qa.seed("initial"))
	t.Cleanup(func() {
		qa.mu.Lock()
		defer qa.mu.Unlock()
		require.Zero(t, qa.feedFetchRequests, "browser acceptance must not fetch feeds")
		require.Empty(t, scheduler.UpdateFeedNowCalls())
		require.Empty(t, scheduler.ExtractContentNowCalls())
		require.Empty(t, scheduler.UpdatePreferenceSummaryCalls())
		require.Empty(t, scheduler.TriggerPreferenceUpdateCalls())
	})

	listener, err := net.Listen("tcp", "127.0.0.1:8082")
	require.NoError(t, err)
	httpServer := &http.Server{Handler: qa, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second,
		WriteTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second}
	t.Cleanup(func() { require.NoError(t, httpServer.Close()) })
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	done := make(chan error, 1)
	go func() { done <- httpServer.Serve(listener) }()
	t.Logf("ticker acceptance ready: %s; POST /__test/scenario {name}; GET /__test/requests", cfg.Server.BaseURL)
	select {
	case err := <-done:
		require.ErrorIs(t, err, http.ErrServerClosed)
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		require.NoError(t, httpServer.Shutdown(shutdownCtx))
		require.ErrorIs(t, <-done, http.ErrServerClosed)
	}
}

type tickerAcceptanceHandler struct {
	mu                sync.Mutex
	t                 *testing.T
	repos             *repository.Repositories
	router            http.Handler
	scenario          tickerAcceptanceScenario
	requests          []tickerAcceptanceRequest
	feedFetchRequests int
}

func (qa *tickerAcceptanceHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	qa.mu.Lock()
	defer qa.mu.Unlock()
	qa.requests = append(qa.requests, tickerAcceptanceRequest{
		Method: r.Method, Path: r.URL.Path, RawQuery: r.URL.RawQuery,
		Scenario: qa.scenario.Name, At: time.Now().UTC(),
	})
	w.Header().Set("Cache-Control", "no-store")
	if strings.Contains(r.URL.Path, "/feeds/") && strings.HasSuffix(strings.TrimRight(r.URL.Path, "/"), "/fetch") {
		qa.feedFetchRequests++
		qa.t.Errorf("forbidden feed fetch request: %s %s", r.Method, r.URL.Path)
		http.Error(w, "feed fetching is forbidden in acceptance", http.StatusForbidden)
		return
	}
	if r.Method == http.MethodGet && r.URL.Path == "/__test/requests" {
		qa.writeJSON(w, map[string]any{
			"scenario": qa.scenario, "requests": qa.requests,
			"feedFetchRequests": qa.feedFetchRequests, "noFeedFetch": qa.feedFetchRequests == 0,
		})
		return
	}
	if r.Method == http.MethodPost && r.URL.Path == "/__test/scenario" {
		var body struct {
			Name string `json:"name"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
		if err := decoder.Decode(&body); err != nil {
			http.Error(w, "expected JSON body with scenario name", http.StatusBadRequest)
			return
		}
		if err := qa.seed(body.Name); err != nil {
			status := http.StatusInternalServerError
			if errors.Is(err, errTickerAcceptanceScenario) {
				status = http.StatusBadRequest
			}
			http.Error(w, err.Error(), status)
			return
		}
		qa.writeJSON(w, qa.scenario)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "only scenario control may write", http.StatusMethodNotAllowed)
		return
	}
	if qa.scenario.Name == "malformed-html" && r.URL.Path == "/articles" {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<html><body>Login</body></html>"))
		return
	}
	if qa.scenario.Name == "outage" && (r.URL.Path == "/rss" || r.URL.Path == "/articles") {
		http.Error(w, "simulated original inventory outage", http.StatusServiceUnavailable)
		return
	}
	if r.URL.Path == "/api/v1/articles" {
		switch qa.scenario.Name {
		case "outage":
			http.Error(w, "simulated articles outage", http.StatusServiceUnavailable)
			return
		case "rss-only":
			http.NotFound(w, r)
			return
		}
	}
	qa.router.ServeHTTP(w, r)
}

func (qa *tickerAcceptanceHandler) writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		qa.t.Errorf("write acceptance control response: %v", err)
	}
}

var errTickerAcceptanceScenario = errors.New("unknown acceptance scenario")

func (qa *tickerAcceptanceHandler) seed(name string) error {
	if name == "reset" || name == "seed" {
		name = "initial"
	}
	initial := []tickerAcceptanceArticle{
		{Title: "甲号重大科研突破：国产开源人工智能推理系统完成跨领域验证并发布可重复实验数据与完整技术报告", Score: 9.8, Level: "L0", AgeHours: 1},
		{Title: "乙号全球气候观察：多国联合发布海洋生态长期调查结果并提出面向未来十年的协同保护行动方案", Score: 9.4, Level: "L0", AgeHours: 1},
		{Title: "丙号城市交通更新：新一代低碳公共交通网络进入全面测试阶段并邀请市民参与无障碍出行体验", Score: 9.0, Level: "L0", AgeHours: 1},
		{Title: "丁号行业观察：开源开发工具发布常规兼容性更新与社区维护计划", Score: 6.5, Level: "L1", AgeHours: 60},
		{Title: "戊号社区简讯：周末读书分享活动公布时间安排与报名说明", Score: 5.5, Level: "L2", AgeHours: 100},
	}
	articles := initial
	switch name {
	case "initial", "recovery", "rss-only":
	case "outage", "malformed-html":
		qa.scenario.Name = name
		return nil
	case "history":
		articles = append([]tickerAcceptanceArticle{}, initial...)
		for i := 0; i < 3; i++ {
			articles[i].AgeHours = 24
		}
		for i := 0; i < 125; i++ {
			articles = append(articles, tickerAcceptanceArticle{Title: fmt.Sprintf("原版历史分页候选第%d号独立内容", i), Score: 5.5, Level: "L2", AgeHours: 1})
		}
	case "empty":
		articles = []tickerAcceptanceArticle{}
	case "lower":
		articles = initial[3:]
	case "l1-only":
		articles = initial[3:4]
	case "l2-only":
		articles = initial[4:]
	case "new-high", "new-high-only":
		articles = append([]tickerAcceptanceArticle{{
			Title: "己号最新高优先级快讯：空间科学团队确认全新观测成果并公布独立复核流程以及下一阶段探索计划", Score: 10, Level: "L0",
		}}, initial...)
		if name == "new-high-only" {
			articles = articles[:1]
		}
	case "one":
		articles = []tickerAcceptanceArticle{{
			Title: "唯一曝光验收长标题：这是一条需要完整滚动展示的中文高优先级新闻，用于确认用户能够看到标题的开始、中间以及最后的完整收尾文字而不会提前消失", Score: 9.9, Level: "L0",
		}}
	default:
		return fmt.Errorf("%w: %q", errTickerAcceptanceScenario, name)
	}
	tx, err := qa.repos.DB.Beginx()
	if err != nil {
		return fmt.Errorf("begin fixture transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.Exec("DELETE FROM items"); err != nil {
		return fmt.Errorf("reset fixture articles: %w", err)
	}
	generation := qa.scenario.Generation + 1
	ids, titles := []string{}, []string{}
	for index := range articles {
		article := &articles[index]
		guid := fmt.Sprintf("ticker-qa-%d-%d", generation, index)
		published := time.Now().UTC().Add(-time.Duration(article.AgeHours)*time.Hour - time.Duration(index+1)*time.Minute)
		result, insertErr := tx.Exec(
			`INSERT INTO items (feed_id, guid, title, link, published, relevance_score, classified_at, topics)
			 VALUES (1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, '["browser-acceptance"]')`,
			guid, article.Title, "https://ticker-qa.invalid/article/"+guid,
			published.Format("2006-01-02 15:04:05"), article.Score)
		if insertErr != nil {
			return fmt.Errorf("seed fixture article: %w", insertErr)
		}
		id, idErr := result.LastInsertId()
		if idErr != nil {
			return fmt.Errorf("read fixture id: %w", idErr)
		}
		article.ID = strconv.FormatInt(id, 10)
		ids, titles = append(ids, article.ID), append(titles, article.Title)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit fixtures: %w", err)
	}
	qa.scenario = tickerAcceptanceScenario{Name: name, Generation: generation, IDs: ids, Titles: titles, Articles: articles}
	return nil
}

type tickerAcceptanceScenario struct {
	Name       string                    `json:"name"`
	Generation int                       `json:"generation"`
	IDs        []string                  `json:"ids"`
	Titles     []string                  `json:"titles"`
	Articles   []tickerAcceptanceArticle `json:"articles"`
}

type tickerAcceptanceArticle struct {
	AgeHours int     `json:"ageHours"`
	ID       string  `json:"id"`
	Title    string  `json:"title"`
	Score    float64 `json:"score"`
	Level    string  `json:"level"`
}

type tickerAcceptanceRequest struct {
	Method   string    `json:"method"`
	Path     string    `json:"path"`
	RawQuery string    `json:"rawQuery"`
	Scenario string    `json:"scenario"`
	At       time.Time `json:"at"`
}
