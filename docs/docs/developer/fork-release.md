---
title: Fork release workflow
sidebar_position: 4
---

# Fork release workflow

This is the lightweight release loop for the OnlyHa1bara fork. It is intended for
bringing a small set of local fixes onto a new Immich release, publishing the
resulting server image to Harbor, and rolling it out through `k3s-configs`.

The normal loop is deliberately small: inspect the upstream delta, replay the
local commits, run checks that match the changed code, build one immutable image,
and let GitOps perform the deployment. A full backup rehearsal, security audit,
or long observation window is not a default gate here. If the upstream release
contains significant database migrations or destructive data changes, stop and
make a separate operations decision before deploying it.

## 1. Inspect the new upstream release

Run these commands from a clean checkout of the fork. Use the exact upstream
release tag as `NEW_TAG` and the tag or commit from which the local fixes were
originally made as `OLD_BASE`.

```bash
git fetch upstream --tags

OLD_BASE=v3.2.0
NEW_TAG=v3.3.0
LOCAL_BRANCH=ha1bara/immich-v3.2.0-job-fix

git log --oneline --decorate "${OLD_BASE}..${NEW_TAG}"
git diff --stat "${OLD_BASE}" "${NEW_TAG}"
git diff --name-only "${OLD_BASE}" "${LOCAL_BRANCH}"
git diff --name-only "${OLD_BASE}" "${NEW_TAG}" -- \
  server/src web packages/cli packages/plugin-core
```

Pay particular attention to files touched by the local fixes and to schema
changes:

```bash
git diff --name-only "${OLD_BASE}" "${NEW_TAG}" -- server/src/schema
git log --oneline "${OLD_BASE}..${NEW_TAG}" -- server/src/schema/migrations
```

Read the relevant release notes or migration files when these commands show a
match. Record the conclusion in the release or deployment change, but do not
turn this inspection into a blanket preflight checklist.

## 2. Replay the local fixes

Keep the local fixes as separate commits when possible. This makes it clear what
needs to be replayed and makes conflict resolution reviewable.

```bash
git log --oneline "${OLD_BASE}..${LOCAL_BRANCH}"
git switch -c "ha1bara/${NEW_TAG}-fork" "${NEW_TAG}"

# Keep the original order of the local fix commits.
git cherry-pick <local-fix-sha-1> <local-fix-sha-2>
```

For uncommitted work, save the complete working-tree diff before switching
bases. Apply it in a fresh checkout based on `NEW_TAG`, then commit it as a
normal local-fix commit. If the work includes new files, stage them with
`git add -N` first so they are included in the patch:

```bash
git add -N <new-files>
git diff HEAD > ../immich-local-fixes.patch
git switch -c "ha1bara/${NEW_TAG}-fork" "${NEW_TAG}"
git apply ../immich-local-fixes.patch
git add <changed-files>
git commit -m "fix: carry local fork changes"
```

### Resolve a cherry-pick conflict

Inspect only the files reported by Git, resolve the markers, and continue the
same cherry-pick. Do not silently drop a local fix because an upstream file was
renamed.

```bash
git status
git diff --name-only --diff-filter=U

# edit the conflicted files, then:
git add <resolved-files>
git cherry-pick --continue
```

Use `git cherry-pick --skip` only when the upstream change demonstrably replaces
that local commit. Use `git cherry-pick --abort` to return to the new-base branch
if the conflict cannot be resolved safely. A final `git log --oneline` and
`git diff --check` should show the intended local commits and no conflict
markers.

## 3. Run targeted checks

Choose checks based on the files changed; do not run the complete CI matrix for
every fork release.

```bash
git diff --check
```

For server TypeScript changes, run the server code checks and the smallest
relevant unit test set:

```bash
cd server
pnpm run check:code
pnpm test --run test/path/to/relevant.test.ts
cd ..
```

For web, CLI, plugin, or documentation-only changes, use that package's normal
check or formatter instead. A full test suite remains useful when the change is
wide or the targeted tests do not cover the touched path, but it is not a
routine release requirement.

## 4. Build and publish one image

Build from the repository root. `server/Dockerfile` copies the server, web, CLI,
and plugin artifacts, so `server/` must not be used as the build context. Choose
an unused, monotonically increasing fork tag; never overwrite a Harbor tag.

```bash
VERSION=3.3.0
TAG="v${VERSION}-ha1bara.1"
IMAGE="harbor.ha1bara.com/ha1bara/immich-server:${TAG}"
SOURCE_COMMIT="$(git rev-parse HEAD)"
SOURCE_REF="$(git branch --show-current)"
SHORT_SHA="$(git rev-parse --short=8 HEAD)"

docker buildx build \
  --platform linux/amd64 \
  -f server/Dockerfile \
  --tag "${IMAGE}" \
  --build-arg BUILD_ID="local-fork-$(date +%Y%m%d)-${SHORT_SHA}" \
  --build-arg BUILD_IMAGE="${IMAGE}" \
  --build-arg BUILD_SOURCE_REF="${SOURCE_REF}" \
  --build-arg BUILD_SOURCE_COMMIT="${SOURCE_COMMIT}" \
  --push .
```

Keep the checkout committed before building. The image metadata records the
source ref and commit; a dirty checkout makes that provenance misleading. After
the push, record the Harbor manifest digest and do one quick image inspection:

```bash
docker buildx imagetools inspect "${IMAGE}"
docker pull "${IMAGE}"
docker image inspect "${IMAGE}" \
  --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | rg '^IMMICH_(BUILD|BUILD_IMAGE|SOURCE_REF|SOURCE_COMMIT)='
```

## 5. Update GitOps and deploy

The active deployment is maintained in the separate `k3s-configs` checkout:

```bash
K3S=/home/ha1bara/dev/ha1bara/k3s-configs
cd "${K3S}"
git status --short
```

Edit the image in
`deploy/self-host/immich/immich-official.yaml` and keep the existing
`$imagepolicy` marker on the line. Review the one-line manifest change, then
commit and push it through the normal GitOps path:

```bash
git diff --check
git diff -- deploy/self-host/immich/immich-official.yaml
git add deploy/self-host/immich/immich-official.yaml
git commit -m "feat(immich): deploy fork ${TAG}"
git push origin main

flux reconcile kustomization flux-system -n flux-system --with-source
kubectl rollout status deployment/immich -n immich --timeout=15m
```

If `git status --short` shows unrelated work, stop and preserve it rather than
rewriting the checkout. The active manifest is the source of truth; a temporary
`kubectl set image` or `rollout restart` is not a replacement for the Git change.

## 6. Lightweight post-deploy check

Confirm that the new pod is ready and uses the image that was just published:

```bash
kubectl get pods -n immich -l app=immich -o wide
kubectl get pods -n immich -l app=immich \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{range .status.containerStatuses[*]}{.imageID}{"\n"}{end}{end}'
kubectl logs -n immich deploy/immich --since=15m \
  | rg -i 'migration|ready|error|template not initialized'
```

Check the service ping through the existing route or port-forward if that is
part of the change. A migration warning or an application error that is new in
this release needs follow-up; existing baseline warnings can be recorded
without blocking the whole release loop.

## Rollback note

Before a new database migration has run, reverting the GitOps image tag is the
normal rollback. Once migrations have run, do not assume that starting the old
image will work; review the migration's compatibility and use the database
recovery procedure if a rollback is required.
