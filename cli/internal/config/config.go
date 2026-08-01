package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

type Config struct {
	Endpoint      string `json:"endpoint,omitempty"`
	SessionCookie string `json:"sessionCookie,omitempty"`
	SignedOut     bool   `json:"signedOut,omitempty"`
}

func Path() (string, error) {
	directory, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("resolve user config directory: %w", err)
	}
	return filepath.Join(directory, "sandpi", "config.json"), nil
}

func Load() (Config, error) {
	path, err := Path()
	if err != nil {
		return Config{}, err
	}
	content, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Config{}, nil
	}
	if err != nil {
		return Config{}, fmt.Errorf("read Sandpi CLI config: %w", err)
	}
	var value Config
	if err := json.Unmarshal(content, &value); err != nil {
		return Config{}, fmt.Errorf("parse Sandpi CLI config: %w", err)
	}
	return value, nil
}

func Save(value Config) error {
	path, err := Path()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create Sandpi CLI config directory: %w", err)
	}
	content, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return fmt.Errorf("encode Sandpi CLI config: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".config-*")
	if err != nil {
		return fmt.Errorf("create Sandpi CLI config: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("protect Sandpi CLI config: %w", err)
	}
	if _, err := temporary.Write(append(content, '\n')); err != nil {
		temporary.Close()
		return fmt.Errorf("write Sandpi CLI config: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return fmt.Errorf("sync Sandpi CLI config: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close Sandpi CLI config: %w", err)
	}
	if err := replaceFile(temporaryPath, path); err != nil {
		return fmt.Errorf("replace Sandpi CLI config: %w", err)
	}
	return nil
}

func replaceFile(temporaryPath, destinationPath string) error {
	if runtime.GOOS != "windows" {
		return os.Rename(temporaryPath, destinationPath)
	}
	if _, err := os.Stat(destinationPath); errors.Is(err, os.ErrNotExist) {
		return os.Rename(temporaryPath, destinationPath)
	} else if err != nil {
		return err
	}
	backupPath := temporaryPath + "-previous"
	if err := os.Rename(destinationPath, backupPath); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, destinationPath); err != nil {
		_ = os.Rename(backupPath, destinationPath)
		return err
	}
	return os.Remove(backupPath)
}
