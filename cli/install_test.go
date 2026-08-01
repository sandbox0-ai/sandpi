package cli_test

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

const installerTestVersion = "1.2.3"

func TestShellInstallerVerifiesAndInstallsLatestRelease(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the shell installer targets Linux and macOS")
	}
	archive := tarGzipArchive(t, "sandpi", []byte("#!/bin/sh\nprintf 'sandpi test binary\\n'\n"), 0o755)
	server := releaseServer(t, "sandpi_1.2.3_linux_amd64.tar.gz", archive, false)
	installDirectory := filepath.Join(t.TempDir(), "bin")

	command := exec.Command("sh", "./install.sh", "--install-dir", installDirectory)
	command.Env = append(os.Environ(),
		"SANDPI_INSTALL_LATEST_URL="+server.URL+"/latest",
		"SANDPI_INSTALL_RELEASE_URL="+server.URL,
		"SANDPI_INSTALL_OS=linux",
		"SANDPI_INSTALL_ARCH=amd64",
	)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("install.sh failed: %v\n%s", err, output)
	}
	if !strings.Contains(string(output), "Installed Sandpi CLI v1.2.3") {
		t.Fatalf("installer output = %q", output)
	}

	binaryPath := filepath.Join(installDirectory, "sandpi")
	result, err := exec.Command(binaryPath).CombinedOutput()
	if err != nil {
		t.Fatalf("installed binary failed: %v\n%s", err, result)
	}
	if string(result) != "sandpi test binary\n" {
		t.Fatalf("installed binary output = %q", result)
	}
	info, err := os.Stat(binaryPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o111 == 0 {
		t.Fatalf("installed binary mode = %o", info.Mode().Perm())
	}
}

func TestShellInstallerRejectsInvalidChecksumWithoutReplacingBinary(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the shell installer targets Linux and macOS")
	}
	archive := tarGzipArchive(t, "sandpi", []byte("replacement"), 0o755)
	server := releaseServer(t, "sandpi_1.2.3_linux_amd64.tar.gz", archive, true)
	installDirectory := t.TempDir()
	binaryPath := filepath.Join(installDirectory, "sandpi")
	if err := os.WriteFile(binaryPath, []byte("existing"), 0o755); err != nil {
		t.Fatal(err)
	}

	command := exec.Command("sh", "./install.sh", "--version", installerTestVersion, "--install-dir", installDirectory)
	command.Env = append(os.Environ(),
		"SANDPI_INSTALL_RELEASE_URL="+server.URL,
		"SANDPI_INSTALL_OS=linux",
		"SANDPI_INSTALL_ARCH=amd64",
	)
	output, err := command.CombinedOutput()
	if err == nil {
		t.Fatalf("install.sh accepted an invalid checksum:\n%s", output)
	}
	content, readErr := os.ReadFile(binaryPath)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(content) != "existing" {
		t.Fatalf("existing binary content = %q", content)
	}
}

func TestPowerShellInstallerVerifiesAndInstallsRelease(t *testing.T) {
	powerShell, err := exec.LookPath("pwsh")
	if err != nil {
		t.Skip("pwsh is not installed")
	}
	archive := zipArchive(t, "sandpi.exe", []byte("sandpi windows test binary"))
	server := releaseServer(t, "sandpi_1.2.3_windows_amd64.zip", archive, false)
	installDirectory := filepath.Join(t.TempDir(), "bin")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	command := exec.CommandContext(
		ctx,
		powerShell,
		"-NoLogo",
		"-NoProfile",
		"-NonInteractive",
		"-File",
		"./install.ps1",
		"-InstallDir",
		installDirectory,
		"-NoModifyPath",
	)
	command.Env = append(os.Environ(),
		"SANDPI_INSTALL_LATEST_URL="+server.URL+"/latest",
		"SANDPI_INSTALL_RELEASE_URL="+server.URL,
		"SANDPI_INSTALL_OS=windows",
		"SANDPI_INSTALL_ARCH=amd64",
	)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("install.ps1 failed: %v\n%s", err, output)
	}
	content, err := os.ReadFile(filepath.Join(installDirectory, "sandpi.exe"))
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "sandpi windows test binary" {
		t.Fatalf("installed binary content = %q", content)
	}
}

func TestPowerShellInstallerRejectsInvalidChecksumWithoutReplacingBinary(t *testing.T) {
	powerShell, err := exec.LookPath("pwsh")
	if err != nil {
		t.Skip("pwsh is not installed")
	}
	archive := zipArchive(t, "sandpi.exe", []byte("replacement"))
	server := releaseServer(t, "sandpi_1.2.3_windows_amd64.zip", archive, true)
	installDirectory := t.TempDir()
	binaryPath := filepath.Join(installDirectory, "sandpi.exe")
	if err := os.WriteFile(binaryPath, []byte("existing"), 0o755); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	command := exec.CommandContext(
		ctx,
		powerShell,
		"-NoLogo",
		"-NoProfile",
		"-NonInteractive",
		"-File",
		"./install.ps1",
		"-Version",
		installerTestVersion,
		"-InstallDir",
		installDirectory,
		"-NoModifyPath",
	)
	command.Env = append(os.Environ(),
		"SANDPI_INSTALL_RELEASE_URL="+server.URL,
		"SANDPI_INSTALL_OS=windows",
		"SANDPI_INSTALL_ARCH=amd64",
	)
	output, err := command.CombinedOutput()
	if err == nil {
		t.Fatalf("install.ps1 accepted an invalid checksum:\n%s", output)
	}
	content, readErr := os.ReadFile(binaryPath)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(content) != "existing" {
		t.Fatalf("existing binary content = %q", content)
	}
}

func releaseServer(t *testing.T, assetName string, archive []byte, invalidChecksum bool) *httptest.Server {
	t.Helper()
	digest := fmt.Sprintf("%x", sha256.Sum256(archive))
	if invalidChecksum {
		digest = strings.Repeat("0", 64)
	}
	checksums := []byte(digest + "  " + assetName + "\n")
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch filepath.Base(request.URL.Path) {
		case "latest":
			response.Header().Set("Content-Type", "text/plain")
			_, _ = response.Write([]byte(installerTestVersion + "\n"))
		case "checksums.txt":
			_, _ = response.Write(checksums)
		case assetName:
			_, _ = response.Write(archive)
		default:
			http.NotFound(response, request)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func tarGzipArchive(t *testing.T, name string, content []byte, mode int64) []byte {
	t.Helper()
	var result bytes.Buffer
	gzipWriter := gzip.NewWriter(&result)
	tarWriter := tar.NewWriter(gzipWriter)
	if err := tarWriter.WriteHeader(&tar.Header{
		Name: name,
		Mode: mode,
		Size: int64(len(content)),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := tarWriter.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	return result.Bytes()
}

func zipArchive(t *testing.T, name string, content []byte) []byte {
	t.Helper()
	var result bytes.Buffer
	writer := zip.NewWriter(&result)
	file, err := writer.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return result.Bytes()
}
