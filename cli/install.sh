#!/bin/sh

set -eu

repository="sandbox0-ai/sandpi"
latest_url="${SANDPI_INSTALL_LATEST_URL:-https://github.com/${repository}/releases/latest/download/version.txt}"
release_url="${SANDPI_INSTALL_RELEASE_URL:-https://github.com/${repository}/releases/download}"
version="latest"
install_dir="${SANDPI_INSTALL_DIR:-}"
temporary_dir=""
staged_binary=""

usage() {
  cat <<'EOF'
Install the Sandpi CLI for Linux or macOS.

Usage:
  install.sh [--version VERSION] [--install-dir DIRECTORY]

Options:
  --version VERSION       Install a specific CLI version (for example 0.1.0).
  --install-dir DIRECTORY Install into DIRECTORY (default: $HOME/.local/bin).
  -h, --help              Show this help text.
EOF
}

fail() {
  printf 'sandpi installer: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  if [ -n "$staged_binary" ]; then
    rm -f "$staged_binary"
  fi
  if [ -n "$temporary_dir" ]; then
    rm -rf "$temporary_dir"
  fi
}

download() {
  source_url="$1"
  destination="$2"
  if ! curl -fsSL --retry 3 --connect-timeout 15 \
    -H "User-Agent: sandpi-installer" \
    -o "$destination" "$source_url"; then
    fail "could not download ${source_url}"
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || fail "--version requires a value"
      version="$2"
      shift 2
      ;;
    --install-dir)
      [ "$#" -ge 2 ] || fail "--install-dir requires a value"
      install_dir="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

if [ -z "$install_dir" ]; then
  [ -n "${HOME:-}" ] || fail "HOME is not set; pass --install-dir"
  install_dir="$HOME/.local/bin"
fi
[ -n "$install_dir" ] || fail "the install directory cannot be empty"

temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/sandpi-install.XXXXXX")" ||
  fail "could not create a temporary directory"
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

if [ "$version" = "latest" ]; then
  version_file="$temporary_dir/version.txt"
  download "$latest_url" "$version_file"
  version="$(sed -n '1 { s/\r$//; p; }' "$version_file")"
else
  version="${version#cli/}"
  version="${version#v}"
fi

if ! printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$'; then
  fail "invalid CLI version: ${version}"
fi

operating_system="${SANDPI_INSTALL_OS:-}"
if [ -z "$operating_system" ]; then
  case "$(uname -s)" in
    Linux) operating_system="linux" ;;
    Darwin) operating_system="darwin" ;;
    *) fail "supported operating systems are Linux and macOS" ;;
  esac
fi

architecture="${SANDPI_INSTALL_ARCH:-}"
if [ -z "$architecture" ]; then
  case "$(uname -m)" in
    x86_64|amd64) architecture="amd64" ;;
    arm64|aarch64) architecture="arm64" ;;
    *) fail "supported architectures are amd64 and arm64" ;;
  esac
fi

case "$operating_system" in
  linux|darwin) ;;
  *) fail "unsupported operating system: ${operating_system}" ;;
esac
case "$architecture" in
  amd64|arm64) ;;
  *) fail "unsupported architecture: ${architecture}" ;;
esac

asset="sandpi_${version}_${operating_system}_${architecture}.tar.gz"
tag_segment="cli%2Fv${version}"
checksums="$temporary_dir/checksums.txt"
archive="$temporary_dir/$asset"
download "${release_url}/${tag_segment}/checksums.txt" "$checksums"
download "${release_url}/${tag_segment}/${asset}" "$archive"

expected="$(awk -v wanted="$asset" '
  {
    filename = $2
    sub(/^\*/, "", filename)
    if (filename == wanted) {
      print $1
      exit
    }
  }
' "$checksums")"
case "$expected" in
  ""|*[!0-9A-Fa-f]*) fail "checksums.txt has no valid checksum for ${asset}" ;;
esac
[ "${#expected}" -eq 64 ] || fail "checksums.txt has an invalid checksum for ${asset}"

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$archive" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$archive" | awk '{ print $1 }')"
else
  fail "sha256sum or shasum is required"
fi

expected="$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')"
actual="$(printf '%s' "$actual" | tr '[:upper:]' '[:lower:]')"
[ "$actual" = "$expected" ] || fail "checksum verification failed for ${asset}"

extracted="$temporary_dir/extracted"
mkdir -p "$extracted"
tar -xzf "$archive" -C "$extracted" sandpi
[ -f "$extracted/sandpi" ] || fail "the release archive does not contain sandpi"

mkdir -p "$install_dir"
staged_binary="$(mktemp "$install_dir/.sandpi.XXXXXX")" ||
  fail "could not stage the Sandpi binary in ${install_dir}"
cp "$extracted/sandpi" "$staged_binary"
chmod 755 "$staged_binary"
mv -f "$staged_binary" "$install_dir/sandpi"
staged_binary=""

printf 'Installed Sandpi CLI v%s to %s/sandpi\n' "$version" "$install_dir"
case ":${PATH:-}:" in
  *":${install_dir}:"*) ;;
  *) printf 'Add %s to PATH before running sandpi.\n' "$install_dir" ;;
esac
