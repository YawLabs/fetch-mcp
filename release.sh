#!/bin/bash
set -euo pipefail
trap 'echo -e "\n\033[0;31m  ✗ Release failed at line $LINENO (exit code $?)\033[0m"' ERR

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

step() { echo -e "\n${CYAN}=== [$1/$TOTAL_STEPS] $2 ===${NC}"; }
info() { echo -e "${GREEN}  ✓ $1${NC}"; }
warn() { echo -e "${YELLOW}  ! $1${NC}"; }
fail() { echo -e "${RED}  ✗ $1${NC}"; exit 1; }

TOTAL_STEPS=7

VERSION="${1:-}"
IS_CI="${CI:-false}"

if [ -z "$VERSION" ]; then
  if [ "$IS_CI" = "true" ] && [ -n "${GITHUB_REF_NAME:-}" ]; then
    VERSION="${GITHUB_REF_NAME#v}"
    info "CI mode — version $VERSION from tag $GITHUB_REF_NAME"
  else
    echo "Usage: ./release.sh <version>"
    echo "  e.g. ./release.sh 0.2.0"
    exit 1
  fi
fi

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Invalid version format: $VERSION (expected X.Y.Z)"

echo -e "${CYAN}Pre-flight checks...${NC}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

command -v node >/dev/null || fail "node not installed"
command -v npm >/dev/null  || fail "npm not installed"
[ "$IS_CI" = "true" ] || command -v gh >/dev/null || fail "gh CLI not installed"

CURRENT_VERSION=$(node -p "require('./package.json').version")
RESUMING=false

if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  RESUMING=true
  info "Already at v${VERSION} — resuming"
else
  if [ "$IS_CI" != "true" ]; then
    [ -z "$(git status --porcelain)" ] || fail "Working directory not clean — commit or stash changes first"
  fi
  info "Current: v${CURRENT_VERSION} → v${VERSION}"
fi

if [ "$IS_CI" != "true" ] && [ "$RESUMING" != "true" ]; then
  echo ""
  echo -e "${YELLOW}About to release v${VERSION}. This will:${NC}"
  echo "  1. Lint + typecheck"
  echo "  2. Build + test"
  echo "  3. Bump version in package.json"
  echo "  4. Commit, push, wait for ci.yml green on the SHA, then tag"
  echo "  5. Publish to npm"
  echo "  6. Create GitHub release"
  echo "  7. Verify"
  echo ""
  read -p "Continue? (y/N) " -n 1 -r
  echo
  [[ $REPLY =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }
fi

step 1 "Lint"
npm run lint || fail "Lint failed"
npm run typecheck || fail "Type check failed"
info "Lint + typecheck passed"

step 2 "Test"
npm run build || fail "Build failed"
npm test || fail "Tests failed"
info "All tests passed"

step 3 "Bump version to $VERSION"
if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  info "Already at v${VERSION} — skipping"
else
  npm version "$VERSION" --no-git-tag-version
  info "Version bumped"
fi

step 4 "Commit, push, wait for CI green, then tag"
if [ "$IS_CI" = "true" ]; then
  info "CI mode — skipping commit/tag/push (tag triggered the workflow)"
else
  if [ -n "$(git status --porcelain package.json package-lock.json 2>/dev/null)" ]; then
    git add package.json package-lock.json
    git commit -m "v${VERSION}"
    info "Committed version bump"
  else
    info "Nothing to commit"
  fi

  git push origin main
  info "Pushed v${VERSION} commit"

  if git tag -l "v${VERSION}" | grep -q "v${VERSION}"; then
    info "Tag v${VERSION} already exists locally — skipping CI gate"
  else
    SHA=$(git rev-parse HEAD)
    info "Waiting for ci.yml to pass on ${SHA:0:7} before tagging..."

    GATE_MAX=90
    RUN_STATUS=""
    RUN_CONCLUSION=""
    for i in $(seq 1 $GATE_MAX); do
      RUN_JSON=$(gh run list --workflow=ci.yml --commit="$SHA" --limit 1 --json status,conclusion,databaseId 2>/dev/null || echo "[]")
      if [ "$RUN_JSON" = "[]" ] || [ -z "$RUN_JSON" ]; then
        echo "    ci.yml not started yet for $SHA (attempt $i/$GATE_MAX)..."
        sleep 10
        continue
      fi
      RUN_STATUS=$(echo "$RUN_JSON" | node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d); console.log(j[0]?.status||"")})')
      RUN_CONCLUSION=$(echo "$RUN_JSON" | node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d); console.log(j[0]?.conclusion||"")})')
      RUN_ID=$(echo "$RUN_JSON" | node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d); console.log(j[0]?.databaseId||"")})')

      if [ "$RUN_STATUS" = "completed" ]; then
        if [ "$RUN_CONCLUSION" = "success" ]; then
          info "ci.yml passed on $SHA (run $RUN_ID)"
          break
        fi
        fail "ci.yml ${RUN_CONCLUSION} on $SHA (run $RUN_ID). Tag NOT created. Inspect: gh run view $RUN_ID --log-failed"
      fi
      echo "    ci.yml ${RUN_STATUS} (attempt $i/$GATE_MAX)..."
      sleep 10
    done

    if [ "$RUN_STATUS" != "completed" ] || [ "$RUN_CONCLUSION" != "success" ]; then
      fail "ci.yml did not finish within 15 minutes. Tag NOT created."
    fi

    git tag "v${VERSION}"
    info "Tag v${VERSION} created"
  fi

  git push origin "v${VERSION}"
  info "Pushed tag v${VERSION} — release.yml will publish from green commit"
fi

step 5 "Publish to npm"
if [ "$IS_CI" = "true" ]; then
  npm publish --access public --provenance
  info "Published @yawlabs/fetch-mcp@${VERSION} (CI, with provenance)"
else
  # Local runs never publish directly — the YawLabs hook blocks `npm publish` and
  # the 2FA-bound local session 404s in headless mode. Wait for release.yml in CI
  # (fired by the tag push in step 4) to publish instead.
  info "Waiting for release.yml in CI to publish v${VERSION}..."
  GATE_MAX=60  # 10 minutes at 10s/poll
  PUBLISHED_VERSION=""
  for i in $(seq 1 $GATE_MAX); do
    PUBLISHED_VERSION=$(npm view @yawlabs/fetch-mcp version 2>/dev/null || echo "")
    if [ "$PUBLISHED_VERSION" = "$VERSION" ]; then
      info "v${VERSION} live on npm"
      break
    fi
    echo "    npm view latest: ${PUBLISHED_VERSION:-none} (attempt $i/$GATE_MAX)..."
    sleep 10
  done
  [ "$PUBLISHED_VERSION" = "$VERSION" ] || fail "release.yml did not publish v${VERSION} within 10 minutes. Inspect: gh run list --workflow=release.yml --limit 3"
fi

step 6 "Create GitHub release"
if gh release view "v${VERSION}" >/dev/null 2>&1; then
  info "GitHub release v${VERSION} already exists — skipping"
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

step 7 "Verify"
sleep 3
NPM_VERSION=$(npm view @yawlabs/fetch-mcp version 2>/dev/null || echo "")
[ "$NPM_VERSION" = "$VERSION" ] && info "npm: @yawlabs/fetch-mcp@${NPM_VERSION}" || warn "npm: ${NPM_VERSION:-nothing} (propagating)"
GH_TAG=$(gh release view "v${VERSION}" --json tagName --jq '.tagName' 2>/dev/null || echo "")
[ "$GH_TAG" = "v${VERSION}" ] && info "GitHub: ${GH_TAG}" || warn "GitHub release not found"

echo -e "\n${GREEN}  v${VERSION} released successfully!${NC}"
echo -e "${GREEN}  npm i -g @yawlabs/fetch-mcp@${VERSION}${NC}\n"
