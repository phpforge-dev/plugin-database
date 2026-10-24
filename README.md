# PHPForge Database / SQL

Standalone Database explorer, SQL consoles, SQL intelligence and native driver library for PHPForge IDE 0.2.13. Install the package from the plugin catalog and explicitly grant project.read, workbench and network.

The workbench package owns source configuration, connection dialogs, schema/table navigation, paged results, SQL console execution, cancellation feedback, Redis editing, schema-aware SQL completion, DDL generation and embedded-PHP SQL mapping. The self-contained SQL worker uses the licensed dt-sql-parser browser parser without Node or remote imports. SQL metadata is read through the authorized host broker; passwords are never sent to an agent.

The Rust crate in native/ owns PostgreSQL, MySQL/MariaDB, SQL Server, Oracle, SQLite and Redis adapters, query construction, metadata extraction, SSH/SSL connection behavior, source persistence and Laravel environment import. The IDE links this package crate as a pinned Git dependency and retains authorization and IPC. It is not a downloaded executable: native library changes require an IDE rebuild. UI installation does not create an arbitrary native-code execution API. Driver-specific limits and cancellation support remain explicit in the interface.

Disabling releases language providers, editor listeners, SQL worker/timers, connection dialogs, results and local state. The host must revoke service permissions and await Database::shutdown() to cancel pending operations, clear sessions and transient passwords, and best-effort cancel queries on PostgreSQL/MySQL. An existing broker instance can be reused after re-enabling. Stored sources exclude passwords; session passwords exist only in memory.

## Integration

activate(sdk) contributes database with transport(method,args,call), languageServices, mountDatabase, sqlConsole, sqlIntelligence, createLanguagePlugin, generateDdl, shortType, statements and changesSqlCatalog. Mount factories preserve their prior signatures and always use sdk.api rather than a caller-supplied unbrokered API. sdk supplies Monaco, translations, icons, own and provide. Read operations and database methods are explicitly declared in plugin.json; host permission checks remain mandatory. The host owns the empty #db shell and generic editor/container layout.

## Verification

Run npm ci --ignore-scripts, npm test, npm run build and npm run test:browser (after npx playwright install webkit). Browser lifecycle tests mount connection dialogs and SQL providers with synthetic services, disable the contribution and verify listeners, providers, context keys, DOM and stale responses are released. Node is build/test tooling only.

Run cargo test --manifest-path native/Cargo.toml --lib. Native tests use disposable SQLite files and synthetic credentials; live database integration is explicitly ignored by default. CI validates the Rust library on macOS, Linux and Windows and the browser bundle on Linux. No real database or inference is used.

MIT PHPForge implementation. Third-party SQL parser notices are included under licenses/sql-intelligence/.

The transport adapter owns SQL statement preprocessing, Redis newline commands, schema type normalization, native DDL transformation and SQL catalog connection/invalidation side effects. The host invokes it for authorized database-prefixed operations and supplies the restricted native transport. Project-change events reset package state. languageServices exposes credential-free SQL completion and declaration lookup to the generic language host.
