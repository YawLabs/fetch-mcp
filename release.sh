#!/bin/bash
# Local release flow for @yawlabs/fetch-mcp.
#
# Prereq: an active npm session in ~/.npmrc (Jeff runs `npm login --auth-type=web`
# in his own terminal -- WebAuthn requires a browser). This script does NOT log in.
#
# Steps:
#   1. lint + typecheck
#   2. build + test
#   3. bump package.json
#   4. commit + push
#   5. npm publish --access public (with EOTP retry -- fresh sessions need ~30s
#      to propagate through npm's auth backend)
#   6. tag + push tag (only after publish succeeds, so the tag means "shipped")
#   7. gh release create

set -euo pipefail
trap 'echo -e "\n\033[0;31m  x Release failed at line $LINENO (exit code $?)\033[0m"' ERR

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

TOTAL_STEPS=7
step() { echo -e "\n${CYAN}=== [$1/$TOTAL_STEPS] $2 ===${NC}"; }
info() { echo -e "${GREEN}  + $1${NC}"; }
warn() { echo -e "${YELLOW}  ! $1${NC}"; }
fail() { echo -e "${RED}  x $1${NC}"; exit 1; }

VERSION="${1:-}"
[ -n "$VERSION" ] || { echo "Usage: ./release.sh <version>"; echo "  e.g. ./release.sh 0.4.0"; exit 1; }
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Invalid version format: $VERSION (expected X.Y.Z)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo -e "${CYAN}Pre-flight checks...${NC}"
command -v node >/dev/null || fail "node not installed"
command -v npm  >/dev/null || fail "npm not installed"
command -v gh   >/dev/null || fail "gh CLI not installed"

# Verify npm session is alive. `npm whoami` returns 401 / "ENEEDAUTH" when the
# session is missing or expired, which is the most common failure mode here.
WHOAMI=$(npm whoami 2>&1) || fail "npm session missing or expired -- run: npm login --auth-type=web"
info "npm: logged in as $WHOAMI"

CURRENT_VERSION=$(node -p "require('./package.json').version")
RESUMING=false
if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  RESUMING=true
  info "Already at v${VERSION} -- resuming"
else
  [ -z "$(git status --porcelain)" ] || fail "Working directory not clean -- commit or stash changes first"
  info "Current: v${CURRENT_VERSION} -> v${VERSION}"
fi

if [ "$RESUMING" != "true" ]; then
  echo ""
  echo -e "${YELLOW}About to release v${VERSION}. This will:${NC}"
  echo "  1. Lint + typecheck"
  echo "  2. Build + test"
  echo "  3. Bump version in package.json"
  echo "  4. Commit + push to main"
  echo "  5. Publish to npm"
  echo "  6. Tag + push tag"
  echo "  7. Create GitHub release"
  echo ""
  read -p "Continue? (y/N) " -n 1 -r
  echo
  [[ $REPLY =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }
fi

step 1 "Lint + typecheck"
npm run lint || fail "Lint failed"
npm run typecheck || fail "Type check failed"
info "Lint + typecheck passed"

step 2 "Build + test"
npm run build || fail "Build failed"
npm test || fail "Tests failed"
info "Build + tests passed"

step 3 "Bump version to $VERSION"
if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  info "Already at v${VERSION} -- skipping"
else
  npm version "$VERSION" --no-git-tag-version
  info "Version bumped"
fi

step 4 "Commit + push"
if [ -n "$(git status --porcelain package.json package-lock.json 2>/dev/null)" ]; then
  git add package.json package-lock.json
  git commit -m "v${VERSION}"
  info "Committed v${VERSION}"
else
  info "Nothing to commit"
fi
git push origin main
info "Pushed v${VERSION} commit to main"

step 5 "Publish to npm"
# A freshly-issued WebAuthn session needs ~30s to propagate through npm's auth
# backend. The first one or two publishes can EOTP/401 even though the session
# is valid; a humble retry wins. Cap at 3 attempts.
PUBLISHED=false
for attempt in 1 2 3; do
  if npm publish --access public; then
    info "Published @yawlabs/fetch-mcp@${VERSION}"
    PUBLISHED=true
    break
  fi
  if [ "$attempt" -lt 3 ]; then
    warn "publish attempt $attempt failed -- waiting 30s for npm auth to propagate"
    sleep 30
  fi
done
[ "$PUBLISHED" = "true" ] || fail "npm publish failed after 3 attempts"

step 6 "Tag + push tag"
if git tag -l "v${VERSION}" | grep -q "v${VERSION}"; then
  info "Tag v${VERSION} already exists locally -- skipping create"
else
  git tag "v${VERSION}"
  info "Tag v${VERSION} created"
fi
git push origin "v${VERSION}"
info "Pushed tag v${VERSION}"

step 7 "Create GitHub release"
if gh release view "v${VERSION}" >/dev/null 2>&1; then
  info "GitHub release v${VERSION} already exists -- skipping"
else
  PREV_TAG=$(git tag --sort=-v:refname | grep -A1 "^v${VERSION}$" | tail -1)
  if [ -n "$PREV_TAG" ] && [ "$PREV_TAG" != "v${VERSION}" ]; then
    CHANGELOG=$(git log --oneline "${PREV_TAG}..v${VERSION}" --no-decorate | sed 's/^[a-f0-9]* /- /')
  else
    CHANGELOG="Initial release"
  fi
  gh release create "v${VERSION}" --title "v${VERSION}" --notes "$CHANGELOG"
  info "GitHub release created"
fi

# Sanity check
sleep 3
NPM_VERSION=$(npm view @yawlabs/fetch-mcp version 2>/dev/null || echo "")
if [ "$NPM_VERSION" = "$VERSION" ]; then
  info "npm verify: @yawlabs/fetch-mcp@${NPM_VERSION}"
else
  warn "npm verify: latest is ${NPM_VERSION:-nothing} (registry may still be propagating)"
fi

echo -e "\n${GREEN}  v${VERSION} released successfully!${NC}"
echo -e "${GREEN}  npm i -g @yawlabs/fetch-mcp@${VERSION}${NC}\n"
