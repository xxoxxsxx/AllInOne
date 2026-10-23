package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	_ "time/tzdata"
)

type App struct {
	db           *sql.DB
	ctx          context.Context
	cancel       context.CancelFunc
	mu           sync.Mutex
	runningID    int64
	jobs         sync.WaitGroup
	csrf         string
	publicOrigin string
	basePath     *string
}

func main() {
	dir := flag.String("data", env("DATA_DIR", "./data"), "本地数据目录（容器中使用 /data）")
	addr := flag.String("listen", env("LISTEN_ADDR", "127.0.0.1:8080"), "监听地址")
	backup := flag.String("backup", "", "在线备份数据库至指定新文件后退出")
	check := flag.String("check", "", "检查指定的本机健康检查 URL 后退出")
	flag.Parse()
	if *check != "" {
		client := http.Client{Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		resp, err := client.Get(*check)
		if err != nil {
			log.Fatal(err)
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 {
			log.Fatal("healthcheck: ", resp.StatusCode)
		}
		return
	}
	if *backup != "" {
		if err := backupDB(*dir, *backup); err != nil {
			log.Fatal(err)
		}
		fmt.Println("备份完成:", *backup)
		return
	}
	if err := os.MkdirAll(*dir, 0700); err != nil {
		log.Fatal(err)
	}
	path, err := filepath.Abs(*dir)
	if err != nil {
		log.Fatal(err)
	}
	db, err := openDB(path)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	if err := os.Remove(filepath.Join(path, "setup-token")); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("remove obsolete setup-token: %v", err)
	}
	publicOrigin, err := checkOrigin(os.Getenv("PUBLIC_ORIGIN"))
	if err != nil {
		log.Fatal(err)
	}
	// 聚合站点子路径挂载（AllInOne）：/stocks 前缀，网关剥离后应用内部路由不变。
	var basePath *string
	if raw := strings.TrimRight(strings.TrimSpace(os.Getenv("BASE_PATH")), "/"); raw != "" {
		if !strings.HasPrefix(raw, "/") || !validBasePath(raw) {
			log.Fatal("BASE_PATH 必须是以 / 开头的站内路径，如 /stocks")
		}
		basePath = &raw
	}
	csrf, err := randomToken()
	if err != nil {
		log.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	a := &App{db: db, ctx: ctx, cancel: cancel, csrf: csrf, publicOrigin: publicOrigin, basePath: basePath}
	a.jobs.Add(1)
	go a.scheduleLoop()
	handler := a.routes()
	if basePath != nil {
		handler = a.wrapBase(handler)
	}
	server := &http.Server{Addr: *addr, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 1 << 20}
	done := make(chan os.Signal, 1)
	signal.Notify(done, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-done
		cancel()
		ctx, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		_ = server.Shutdown(ctx)
	}()
	log.Printf("TickerSentry listening on %s (data: %s)", *addr, path)
	err = server.ListenAndServe()
	cancel()
	a.jobs.Wait()
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func env(key, fallback string) string {
	if s := os.Getenv(key); s != "" {
		return s
	}
	return fallback
}

func checkOrigin(raw string) (string, error) {
	if raw == "" {
		return "", nil
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("PUBLIC_ORIGIN 必须是完整的 HTTP(S) 来源地址，不含路径")
	}
	return u.Scheme + "://" + u.Host, nil
}

// validBasePath 校验 BASE_PATH 必须以 / 开头且每段都是安全字符。
func validBasePath(raw string) bool {
	if !strings.HasPrefix(raw, "/") {
		return false
	}
	for _, seg := range strings.Split(strings.Trim(raw, "/"), "/") {
		if seg == "" {
			return false
		}
		for _, r := range seg {
			switch {
			case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			default:
				return false
			}
		}
	}
	return true
}
