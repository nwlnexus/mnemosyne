module.exports = {
  branches: ["main"],
  tagFormat: "v${version}",
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "@semantic-release/changelog",
    ["@semantic-release/npm", { npmPublish: false }],
    [
      "@semantic-release/git",
      {
        assets: ["package.json", "CHANGELOG.md"],
        message: "chore(release): v${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
      },
    ],
    "@semantic-release/github",
    // GitHub's anti-recursion rule silently drops `on: push: tags:` triggers
    // for tags pushed using the default GITHUB_TOKEN (workflow_dispatch is
    // explicitly exempted from that rule, unlike push/tag events) — so the
    // tag @semantic-release/git just pushed will NOT fire npm-publish.yml on
    // its own. Dispatch it explicitly instead of relying on the tag push to
    // cascade. Needs `actions: write` in this workflow's permissions.
    [
      "@semantic-release/exec",
      {
        successCmd:
          "gh workflow run npm-publish.yml --ref ${nextRelease.gitTag}",
      },
    ],
  ],
};
