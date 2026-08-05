rootProject.name = "erd-server"

// Gradle（の元になっている Ant）は Copy / Zip のディレクトリ走査で .gitignore・.gitattributes を
// 既定除外する。配布 ZIP（packageDist）は distribution/.gitignore と distribution/.gitattributes を
// erd/ 直下に同梱するため、この 2 つを既定除外から外す。
// 除外を外すのは Ant のグローバル状態なので、設定スクリプト（構成フェーズの最初）で行う。
org.apache.tools.ant.DirectoryScanner.removeDefaultExclude("**/.gitignore")
org.apache.tools.ant.DirectoryScanner.removeDefaultExclude("**/.gitattributes")
