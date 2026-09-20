# macos-mcp-server - Directory Structure

Generated on: 2026-09-20 14:12:08

```text
macos-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   └── template.md
├── docs/
│   ├── design.md
│   └── idea.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   └── tree.ts
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── macos-audio-devices.resource.ts
│   │   │       ├── macos-displays.resource.ts
│   │   │       └── macos-system-info.resource.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── macos-check-permissions.tool.ts
│   │           ├── macos-control-appearance.tool.ts
│   │           ├── macos-control-audio.tool.ts
│   │           ├── macos-control-system.tool.ts
│   │           ├── macos-control-volume.tool.ts
│   │           ├── macos-get-info.tool.ts
│   │           ├── macos-manage-apps.tool.ts
│   │           ├── macos-manage-displays.tool.ts
│   │           ├── macos-manage-finder.tool.ts
│   │           ├── macos-manage-focus.tool.ts
│   │           ├── macos-manage-windows.tool.ts
│   │           ├── macos-send-notification.tool.ts
│   │           └── macos-take-screenshot.tool.ts
│   ├── services/
│   │   ├── audio/
│   │   │   └── audio-service.ts
│   │   ├── display/
│   │   │   └── display-service.ts
│   │   ├── osascript/
│   │   │   └── osascript-service.ts
│   │   ├── screencapture/
│   │   │   └── screencapture-service.ts
│   │   └── system-info/
│   │       └── system-info-service.ts
│   └── index.ts
├── tests/
│   ├── security/
│   │   └── injection.test.ts
│   ├── services/
│   │   ├── audio-service.test.ts
│   │   ├── display-service.test.ts
│   │   └── system-info-service.test.ts
│   └── tools/
│       ├── error-contract-recovery.test.ts
│       ├── macos-check-permissions.tool.test.ts
│       ├── macos-control-appearance.tool.test.ts
│       ├── macos-control-audio.tool.test.ts
│       ├── macos-control-system.tool.test.ts
│       ├── macos-control-volume.tool.test.ts
│       ├── macos-get-info.tool.test.ts
│       ├── macos-manage-apps.tool.test.ts
│       ├── macos-manage-displays.tool.test.ts
│       ├── macos-manage-finder.tool.test.ts
│       ├── macos-manage-focus.tool.test.ts
│       ├── macos-manage-windows.tool.test.ts
│       ├── macos-send-notification.tool.test.ts
│       └── macos-take-screenshot.tool.test.ts
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CLAUDE.md
├── devcheck.config.json
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
