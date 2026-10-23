package main

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"

	_ "modernc.org/sqlite"
)

// VACUUM INTO creates a consistent SQLite snapshot while the server is running.
// The destination must be new and on a writable, private filesystem.
func backupDB(dir, dest string) error {
	src, err := filepath.Abs(filepath.Join(dir, "ticker.db"))
	if err != nil {
		return err
	}
	dest, err = filepath.Abs(dest)
	if err != nil {
		return err
	}
	if src == dest {
		return errors.New("备份路径不能是活动数据库")
	}
	if _, err = os.Stat(src); err != nil {
		return fmt.Errorf("源数据库不可用: %w", err)
	}
	if _, err = os.Lstat(dest); err == nil {
		return errors.New("备份文件已存在")
	} else if !os.IsNotExist(err) {
		return err
	}
	parent := filepath.Dir(dest)
	if err = os.MkdirAll(parent, 0700); err != nil {
		return err
	}
	// Backup runs in a separate short-lived process; ensure new SQLite file is private.
	old := syscall.Umask(0077)
	defer syscall.Umask(old)
	db, err := sql.Open("sqlite", src)
	if err != nil {
		return err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err = db.Exec(`PRAGMA busy_timeout=5000`); err != nil {
		return err
	}
	if _, err = db.Exec(`VACUUM INTO ?`, dest); err != nil {
		os.Remove(dest)
		return err
	}
	return os.Chmod(dest, 0600)
}
