# ERForge

[Japanese](README.ja.md)

**A tool for evolving ER diagrams and table definitions together with your database and Git.**

ERForge imports schemas from a database and manages ER diagrams, table definitions, logical names, and notes as a single deliverable.
When the database changes, you can review the diff before updating, while preserving explanations written by people.

| Common problem | How ERForge helps |
|---|---|
| **Documentation quickly goes stale.** The database changes, but the documents tend to stay as they were. | Import the latest table information from the database. Because you can review changes before applying them, table definitions can be kept up to date without friction. |
| **ER diagrams and table definitions are managed separately,** and are hard to keep in sync. It becomes unclear which one is correct. | ER diagrams, table lists, and column details are all shown from the same data. This reduces drift caused by updating only one side. |
| **Business explanations disappear at the next update.** | Human-written information such as logical names, notes, and tags can be kept while only database-derived information is updated. |
| **Asking readers to install dedicated software is inconvenient.** | The deliverable is an HTML file that runs without a server. Recipients can open it in a browser to view ER diagrams and table definitions. |
| **Changes are hard to review.** Binary documents do not show useful diffs. | Data is stored as text. You can review changes with Git diffs, just like code. |

If you place the deliverable in a repository, ER diagrams and table definitions can grow through the same workflow as your code.

# Features

ERForge lets you manage ER diagrams, table definitions, and supplemental notes together.
It can import database changes while preserving human-written logical names and notes, so documentation can stay current without unnecessary manual work.

## ER Diagram Authoring Support

Tables imported from the database are automatically prepared as ER diagram nodes.
You can create readable ER diagrams simply by placing the nodes you need on the canvas.

- Nodes for each table are already generated, so you do not need to draw boxes from scratch
- Relationships backed by physical foreign keys are drawn automatically
- Pages can be split by business area to keep diagrams easy to read

![ER diagram screen](docs/images/erd-canvas.png)

## Updating Definitions From the Database

ERForge can connect to a real database and read tables, columns, constraints, and comments.
Changes can be reviewed before import, helping you avoid unintended overwrites while updating the documentation.

- Review additions, deletions, and modifications as diffs
- Keep existing logical names and notes when tables or columns are renamed
- Exclude tables that do not need documentation from future imports

![Reverse engineering diff preview](docs/images/introspect-diff.png)

## Unified Management of ER Diagrams and Definitions

ER diagrams, table lists, and column details all refer to the same data.
This prevents inconsistencies such as "it looks this way in the ER diagram, but the definition says something else."

- Open a dialog from the ER diagram to check detailed information
- Jump quickly between ER diagrams and table details through cross-links

![Table detail screen](docs/images/table-catalog.png)

## Rich Documentation Features

In addition to physical information retrieved from the database, ERForge can organize business meaning and supplemental explanations.
You can record what tables and columns mean, points to watch out for, and how they are classified, in a form readers can follow.

- Add logical names to tables and columns
- Show relationships that have no physical foreign key in the database as supplemental information in the diagram
- Organize information with supplemental notes and tags
- Manage column logical names and tags together in the column dictionary
- Re-import from the database while preserving logical names, notes, and tags

![Column dictionary screen](docs/images/column-dictionary.png)

## Git-Friendly Deliverables

Data is stored as text, so changes can be checked with `git diff`.
Updates to ER diagrams and table definitions can be reviewed in pull requests, just like code.

- Text format with readable diffs
- Deterministic output — the same content always produces the same file
- Easy to fit into team development workflows

## Browser-Ready Deliverables

The viewing deliverable is an HTML / JavaScript file that runs without a server.
Recipients can open it in a browser and view ER diagrams and table definitions without a dedicated tool or server.

- Viewable without installation
- Supports Japanese / English display
- Database information never leaves your machine
- Export a ZIP containing only what is needed for viewing, from the header tool menu or with
  `erd.bat export`. You can choose the file name and the workspaces to include, then hand the ZIP
  as is to people who do not use Git. Connection information and drivers are not included.

## Supported Databases

ERForge can be used with many databases as long as a JDBC driver is available.
It can retrieve database-specific information from PostgreSQL / MySQL, and SQL Server / Oracle / SQLite are also verified to work.

# For Developers

## Structure

| Directory | Contents |
|---|---|
| `server/` | Java 17 / Gradle. Core code for models, deterministic printers, index generation, and migrations, plus the Javalin web layer. |
| `viewer/` | TypeScript / React / Vite. All assets are inlined into a single `index.html`. |
| `fixtures/` | Golden fixtures shared by Java and TypeScript. Ensure that printer output matches across both. |
| `distribution/` | Static files bundled in the distribution ZIP, including startup scripts, README, and `.gitignore` / `.gitattributes` for the extracted `erd/` directory. |
| `dev-db/` | Databases for verification, including docker compose setups for PostgreSQL / MySQL / SQL Server / Oracle, plus schema migrations per database product. See [README](dev-db/README.md). |

## Starting the Development Environment

You can develop with the **server connected to the HMR-enabled viewer** without rebuilding the release package.
It runs through **exactly the same route as the distribution**: the Java server serves `workspace-*/data/**.js`, and the viewer loads it through `<script>`.
This avoids dev-only behavior differences. Use two terminals.

```sh
# 1) Java server. Data is under dev/. This does not open a browser.
cd server && ./gradlew devServer

# 2) Viewer. Vite dev server. This opens a browser automatically.
cd viewer && npm run dev
```

`http://localhost:5173/?t=erd-dev` will open. When you save source files, viewer changes are reflected immediately through HMR.
When you change the server side, restart `gradlew devServer`.

| | Contents |
|---|---|
| Project directory | `dev/` (not tracked by Git). This corresponds to `erd/` in the distribution. |
| Data | `dev/workspace-<id>/data/` (per workspace) |
| First launch | If there is no workspace, proceed from the creation screen to the bootstrap screen. **Import the sample to try it immediately.** |
| JDBC drivers | Put them in `dev/drivers/*.jar` when trying reverse engineering. See [dev-db/](dev-db/README.md). Settings are in `dev/config.js` and shared by all workspaces. |
| Server port | `5321` (automatically increments if already in use). Can be changed with `ERD_PORT`. |
| Token | Fixed to `erd-dev` (`ERD_TOKEN`) to keep the dev URL stable. The distribution uses a random token each time. |

**How it works**: The viewer always loads data through relative paths such as `<script src="workspace-<id>/data/**.js">`
(there is only one loading route regardless of mode). Vite dev proxies `/workspace-*/data/`,
`/workspaces.js`, and `/__erd` to the Java server. Since `GET /__erd/health` succeeds, the viewer enters server mode.

> Vite's `public/` is **not used** (`publicDir: false`). If data with the same name is placed under `public/`,
> the viewer may load it first and end up showing that data instead of the server's real data, so we keep a single loading path.
> To verify static mode (`file://`), place the built `index.html` alongside `workspaces.js` and
> `workspace-<id>/data/`, then open it (`npm run e2e` builds exactly that setup).

If you change `ERD_PORT`, pass the same value to the viewer so the proxy target matches.

```sh
cd server && ERD_PORT=5400 ./gradlew devServer
cd viewer && ERD_PORT=5400 npm run dev
```

In PowerShell, run `$env:ERD_PORT="5400"` first.

### Databases for Verification

[dev-db/](dev-db/README.md) provides a PostgreSQL environment (docker compose) and a set of migrations that can be applied step by step,
so you can test reverse engineering against a real database.

The container starts with an **empty database**. The schema, including initialization (`000_init.sql`), is applied through `migrate.mjs`.

```sh
cd dev-db && docker compose up -d && npm install
node migrate.mjs up 000     # Applies the initial schema (about 30 tables; source data for the bundled sample)
node migrate.mjs up 001     # Applies ENUM / CHECK / partial and expression indexes
```

In addition to **MySQL**, the project includes **SQL Server / Oracle** for additional introspection verification
(separated by docker compose profiles) and **SQLite** (no Docker required, in-process).
For the Docker-based databases other than PostgreSQL, the **initial schema is applied automatically when the container starts**.
See [dev-db/README.md](dev-db/README.md) for details.

## Build

```sh
# Viewer. Generates viewer/dist/index.html.
cd viewer && npm install && npm run build

# Server. Generates server/build/libs/erd-server.jar.
cd server && ./gradlew shadowJar
```

## Test

```sh
cd viewer && npm run typecheck && npm test && npm run e2e   # e2e performs a file:// smoke test after the build
cd server && ./gradlew test
```

## Release

The release procedure is as follows.

1. Update and commit **`VERSION`** at the repository root (for example, `0.3.0`)
2. **Create a tag**: `git tag v0.3.0` (**the tag and `VERSION` must match**)
3. On Windows, run **`build-dist.bat`**. On macOS / Linux, run **`./build-dist.sh`**
   (this automates npm install, viewer build, shadowJar, and ZIP assembly. `--no-pause` can be used for automation)
4. Manually upload `server/build/dist/ERForge-<VERSION>.zip` (for example, `ERForge-0.3.0.zip`) to GitHub Releases
   (the file name is derived from `VERSION`. The absolute path is shown when the build completes)

To build manually, run:

```sh
cd server && ERD_RELEASE=1 ./gradlew packageDist
```

### Version

**The root-level `VERSION` file (one line) is the single source of truth for the version**.
At build time, it is embedded into both `index.html` (Vite define) and `erd-server.jar` (manifest `Implementation-Version`),
and is displayed in the top-right **information (i)** panel. In server mode, the jar version is also retrieved from
`GET /__erd/health` and shown alongside it; if they differ, a warning is displayed so you notice when only `index.html` has been replaced.

Only **release builds (`build-dist.*`) set `ERD_RELEASE=1`**, so they use the exact `VERSION`.
All other local builds get a `-dev` suffix, for example `0.2.0-dev`. When running without creating a jar, such as `gradlew devServer`, the version is `dev`.

This is versioned **independently** of the data format version (`schemaVersion`), and the two are not linked.

JDBC drivers are not bundled in the distribution. Users can download drivers for major databases from Maven through the reverse engineering screen
(settings are stored in `erd/config.js` under `drivers`, shared by all workspaces; default versions are managed by `DriverCatalog`).
This policy accounts for licenses (MySQL is GPL, Oracle is proprietary) and ZIP size.

## Regenerating Bundled Sample Data

If you change `dev-db/postgresql/migrations/000_init.sql`
(the dev-db initial schema and source data for the bundled sample), run:

```sh
cd server && ./gradlew generateSampleData
```

`server/src/main/resources/erd-sample/` will be regenerated. Review it visually and commit it.
