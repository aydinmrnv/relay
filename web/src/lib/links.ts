/** The engine's public repository. Safe to import from server and client code alike. */
export const REPO_URL = 'https://github.com/aydinmrnv/relay';

/** Installs the CLI from the repository's rolling release. There is no npm package: the tarball is the distribution. */
export const CLI_INSTALL_COMMAND = `npm install -g ${REPO_URL}/releases/download/cli-latest/relay.tgz`;

/** The GitHub Action an exported workflow runs, at the major version tag the repository maintains. */
export const ACTION_REF = 'aydinmrnv/relay@v1';

/** Who runs the hosted studio, and where to write to them: the legal pages, error messages and the request-access link. */
export const OPERATOR = 'NullStack.one';
export const SUPPORT_EMAIL = 'support@nullstack.one';
