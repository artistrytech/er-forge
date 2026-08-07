# ERForge

[Japanese](README.ja.md)

This tool helps maintain database ER diagrams and table catalogs in a Git-friendly format.

See: https://github.com/artistrytech/er-forge

## Included Files

| File | Description |
|---|---|
| `erd-server.jar` | Server mode application. Requires Java 17 or later. |
| `index.html` | Viewer. A single HTML file that can be opened directly in a browser. |
| `erd.bat` / `erd.sh` | Startup scripts. Run without arguments to start the server, or with `export` to create a viewer ZIP. |
| `drivers/` | Location for JDBC drivers. Empty by default and **shared by all workspaces**. Drivers for major databases can be downloaded from the reverse engineering screen. You can also place JAR files manually. See `drivers/README.txt`. |
| `THIRD-PARTY-NOTICES.txt` | Copyright and license notices for bundled open source software. |
| `.gitignore` / `.gitattributes` | Git settings for this directory. Commit them as is after extracting the ZIP. |

## Setup

1. Extract the contents of this ZIP into any directory inside your project repository.
2. Commit the extracted directory as is.

   ```
   git add erd
   git commit -m "Add ER diagram management tool"
   ```

**The directory name is up to you**. This document uses `erd/` as an example. The server treats the directory it is placed in as the project root, and the bundled `.gitignore` / `.gitattributes` work relative to that directory, so the name and nesting depth do not matter.

You do not need to add anything to your project's own `.gitignore`. The bundled `.gitignore` already covers everything that should be excluded, and all files created by the tool, including personal data, stay inside this directory.

## Git Management Policy

**As a rule, everything in the extracted directory should be tracked by Git**, including `erd-server.jar` and the startup scripts.
This lets every member use the same tool version and data after a simple `git pull`.
To upgrade, extract the new ZIP over the same location and commit the diff.
**Do not delete the directory and extract it again.** That would also delete schema data and personal data.

| Target | Track in Git | Notes |
|---|---|---|
| `index.html`, `erd-server.jar`, `erd.sh`, `erd.bat` | Yes | Marked as binary in `.gitattributes` to reduce diff noise. |
| `workspaces.js`, `config.js`, `workspace-*/data/**` | Yes | Review targets. |
| `drivers/README.txt` | Yes | Explains how to place drivers. |
| `.local/` | No | Personal data, including database connection information (passwords only when explicitly saved), backups taken before reverse engineering is applied, and personal settings. |
| `drivers/*.jar` | No | Downloaded by each user for licensing reasons. |

## Usage

### For Editors: Server Mode

Requires Java 17 or later.

Run `erd.bat` on Windows or `./erd.sh` on macOS / Linux. The server starts at
`http://127.0.0.1:5321/`, and the browser opens automatically.

On first launch, the workspace creation screen is shown. You are expected to create one workspace per database.
Enter an ID (letters, numbers, hyphens, and underscores; defaults to `default` if omitted) and a display name, and
`workspace-<ID>/` will be created. When working with multiple databases, you can add or switch workspaces from the dropdown next to the application title.

The bootstrap screen is shown next. If you choose "Import sample data", a ready-made sample of about 30 tables is written to
`workspace-<ID>/data/`, so you can try the features without a database.

After editing, commit and push `workspaces.js` and `workspace-*/data/**`.
If you changed driver settings, commit `config.js` as well.

### For Readers: Static Mode

Java is not required.

Run `git pull` and open `index.html` in a browser.
You can browse ER diagrams, search, and use the table catalog right away.

### Sharing With People Who Do Not Use Git

You can create a ZIP that contains only what is needed for viewing.
Recipients only need to extract it and open `index.html` in a browser. Git and Java are not required.

```
ERForge-viewer-20260806-2312.zip
|-- index.html
|-- workspaces.js
|-- workspace-<ID>/data/**      selected workspaces
`-- THIRD-PARTY-NOTICES.txt
```

**Connection information (`.local/`), JDBC drivers, and `erd-server.jar` are not included.**
This prevents database credentials from being mixed in when sharing outside the company, but note that
**all schema content for the selected workspaces is included**.

#### From the Screen

In server mode, choose **Tools (wrench) -> Export viewer ZIP** from the header.
You can specify the file name and included workspaces, and the file is saved as a browser download.
The screen also shows the command that produces the same output, so you can copy it if you later want to switch to scheduled runs.

#### From the Command Line

This can be used without starting the server.

```
erd.bat export      (Windows)
./erd.sh export     (macOS / Linux)
```

The ZIP is created in this directory. Both options can be omitted.

| Option | Default | Example |
|---|---|---|
| `--prefix=<name>` | `ERForge-viewer` | `erd.bat export --prefix="Sales ERD"` |
| `--workspaces=<a,b>` | All workspaces | `erd.bat export --workspaces=sales,billing` |

The file name becomes `<name>-<timestamp>.zip`. The name may contain Japanese characters and spaces.
Characters that are invalid in file names, such as `\ / : * ? " < > |`, cannot be used.

### Exporting Schema Information

Available in both modes.

Use **Tools (wrench) -> Export schema information as JSON** in the header to save all table definitions,
metadata (logical names, tags, colors, notes, and logical constraints), and relations into a single JSON file
named `schema-<workspace-id>.json`.

Page information and ER diagram placement are not included.
Column dictionary logical names and tags are exported into each table's `meta.columns`, so tools that consume the file do not need to resolve
"individual table -> dictionary" values. Dictionary colors are display attributes and are not exported.
The output is minified JSON, intended to be passed to other tools.
