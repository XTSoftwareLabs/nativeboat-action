# NativeBoat Build Action

Compile an Electron project into a native Windows application in GitHub Actions.
The action downloads the compiler and runtime from
[XTSoftwareLabs/nativeboat-release](https://github.com/XTSoftwareLabs/nativeboat-release),
then runs the compiler's `build` command on the configured project directory.

## Usage

```yaml
name: Native Windows build

on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: '22'
      - uses: XTSoftwareLabs/nativeboat-action@v1
        id: nativeboat
        with:
          project-path: apps/desktop-electron
      - uses: actions/upload-artifact@v7
        with:
          name: native-windows
          path: ${{ steps.nativeboat.outputs.output-path }}
          if-no-files-found: error
```

Use a Windows x64 runner. The project can be used as checked out: when its
dependencies are not installed, NativeBoat installs them in a build copy of the
project (see `work-dir`). Make Node.js and the project's package manager
available, for example with `actions/setup-node` and `pnpm/action-setup` for a
pnpm project. Projects whose packaging scripts build helper programs also need
the corresponding build tools. Installing dependencies before the action works too.

`@v1` follows the latest `v1.x.y` release of this action. Pin a full release tag
such as `@v1.0.0`, or a commit SHA, for reproducible CI, and pin the compiler with
`version` using an exact published release tag, including its `v` prefix.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `project-path` | `.` | Electron project directory, relative to the checked-out repository. Absolute paths are accepted. |
| `version` | `latest` | Exact compiler release tag. `latest` selects the newest stable release, or the newest prerelease when no stable release exists. |
| `output-path` | `native-dist` | Output directory, relative to the Electron project. Absolute paths are accepted. |
| `work-dir` | | Directory for build copies of projects whose dependencies are not installed, relative to the workspace. Empty uses `%LOCALAPPDATA%\nativeboat\projects`. |
| `sign` | | Signing command such as `signtool sign /a /fd SHA256 {file}`. `{file}` becomes the quoted executable path. Empty skips signing. |
| `analyze` | `false` | Run `nativeboat analyze` first and print its support report. |
| `token` | `${{ github.token }}` | GitHub token for release metadata requests. An empty token uses unauthenticated requests. |

## Outputs

| Output | Description |
| --- | --- |
| `output-path` | Absolute directory containing the built application and any accompanying files. |
| `executable` | Absolute path of the built executable when the output directory contains exactly one `.exe`; otherwise empty. |
| `compiler-path` | Absolute path to the downloaded compiler executable. |
| `version` | Resolved compiler release tag. |

Upload the output directory to preserve accompanying resources and helper programs.
Compiler failures fail the action step and print the compiler's diagnostics.

## Release packages

The action downloads `nativeboat-<version>-windows-x64.zip` from the selected
release and extracts it with Windows' `tar`. The package holds `nativeboat.exe`
and its `toolchain` directory at its root; a single enclosing directory is also
supported.

Downloads use the public release URLs. The action checks the asset size and
GitHub's SHA-256 digest when present, and the `SHA256SUMS.txt` entry when that
file is included. A mismatch fails before extraction.

## License

This action is released under the [MIT License](LICENSE). The NativeBoat compiler it
downloads is a separate product under its own
[license](https://github.com/XTSoftwareLabs/nativeboat-release/blob/main/LICENSE.md):
it is free for open source projects and for non-commercial projects, while
closed-source commercial use needs a license from
[nativeboat@xtsoftwarelabs.com](mailto:nativeboat@xtsoftwarelabs.com). Using this
action means using the compiler under those terms.

## Privacy

The action collects no personal data and sends no telemetry. It contacts only
GitHub: the GitHub API, with the `token` input, to read release metadata from
`XTSoftwareLabs/nativeboat-release`, and that repository's release downloads,
without a token. The token is not passed to the compiler or to the project's
build commands. Installing the project's dependencies contacts the package
registries the project uses. The compiler's own handling of data is governed by
its license.

## Support

Report problems with this action in its
[issues](https://github.com/XTSoftwareLabs/nativeboat-action/issues). Report
compiler problems in the
[NativeBoat release issues](https://github.com/XTSoftwareLabs/nativeboat-release/issues),
and send licensing questions to
[nativeboat@xtsoftwarelabs.com](mailto:nativeboat@xtsoftwarelabs.com).

## Development

```powershell
npm ci
npm run check
npm test
```

The action runs directly from `src/` with the GitHub runner's Node.js 24 runtime.
It uses only Node.js built-ins. Tests run on Windows and Linux. The **Smoke
build** workflow compiles the included Electron fixture using a published compiler
release; run it manually with the desired release tag.

Releases use `vX.Y.Z` tags. Publishing a stable release runs the **Update major
tag** workflow, which moves the `vX` tag to that release.
