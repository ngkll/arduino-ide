// @ts-check

(async () => {
  const os = require('node:os');
  const path = require('node:path');
  const { exec } = require('./utils');
  const glob = require('glob');
  const { v4 } = require('uuid');
  const shell = require('shelljs');
  const protoc = path.dirname(require('protoc/protoc'));

  const repository = path.join(os.tmpdir(), `${v4()}-arduino-cli`);
  if (shell.mkdir('-p', repository).code !== 0) {
    shell.exit(1);
  }

  const { owner, repo, commitish } = (() => {
    const pkg = require(path.join(__dirname, '..', 'package.json'));
    if (!pkg) {
      shell.echo(`Could not parse the 'package.json'.`);
      shell.exit(1);
    }

    const defaultVersion = {
      owner: 'arduino',
      repo: 'arduino-cli',
      commitish: undefined,
    };
    const { arduino } = pkg;
    if (!arduino) {
      return defaultVersion;
    }

    const { cli } = arduino;
    if (!cli) {
      return defaultVersion;
    }

    const { version } = cli;
    if (!version) {
      return defaultVersion;
    }

    if (typeof version === 'string') {
      return defaultVersion;
    }

    // We assume an object with `owner`, `repo`, commitish?` properties.
    const { owner, repo, commitish } = version;
    if (!owner) {
      shell.echo(`Could not retrieve 'owner' from ${JSON.stringify(version)}`);
      shell.exit(1);
    }
    if (!repo) {
      shell.echo(`Could not retrieve 'repo' from ${JSON.stringify(version)}`);
      shell.exit(1);
    }

    return { owner, repo, commitish };
  })();

  const url = `https://github.com/${owner}/${repo}.git`;
  shell.echo(`>>> Cloning repository from '${url}'...`);
  exec('git', ['clone', url, repository], shell);
  shell.echo(`<<< Repository cloned.`);

  const { platform } = process;
  const build = path.join(__dirname, '..', 'build');
  const cli = path.join(
    build,
    `arduino-cli${platform === 'win32' ? '.exe' : ''}`
  );
  const versionJson = exec(cli, ['version', '--format', 'json'], shell).trim();
  if (!versionJson) {
    shell.echo(`Could not retrieve the CLI version from ${cli}.`);
    shell.exit(1);
  }
  // As of today (28.01.2021), the `VersionString` can be one of the followings:
  //  - `nightly-YYYYMMDD` stands for the nightly build, we use the , the `commitish` from the `package.json` to check out the code.
  //  - `0.0.0-git` for local builds, we use the `commitish` from the `package.json` to check out the code and generate the APIs.
  //  - `git-snapshot` for local build executed via `task build`. We do not do this.
  //  - rest, we assume it is a valid semver and has the corresponding tagged code, we use the tag to generate the APIs from the `proto` files.
  /*
      {
        "Application": "arduino-cli",
        "VersionString": "nightly-20210126",
        "Commit": "079bb6c6",
        "Status": "alpha",
        "Date": "2021-01-26T01:46:31Z"
      }
      */
  const versionObject = JSON.parse(versionJson);
  const version = versionObject.VersionString;
  if (
    version &&
    !version.startsWith('nightly-') &&
    version !== '0.0.0-git' &&
    version !== 'git-snapshot'
  ) {
    shell.echo(`>>> Checking out tagged version: '${version}'...`);
    exec('git', ['-C', repository, 'fetch', '--all', '--tags'], shell);
    exec(
      'git',
      ['-C', repository, 'checkout', `tags/${version}`, '-b', version],
      shell
    );
    shell.echo(`<<< Checked out tagged version: '${version}'.`);
  } else if (commitish) {
    shell.echo(
      `>>> Checking out commitish from 'package.json': '${commitish}'...`
    );
    exec('git', ['-C', repository, 'checkout', commitish], shell);
    shell.echo(
      `<<< Checked out commitish from 'package.json': '${commitish}'.`
    );
  } else if (versionObject.Commit) {
    shell.echo(
      `>>> Checking out commitish from the CLI: '${versionObject.Commit}'...`
    );
    exec('git', ['-C', repository, 'checkout', versionObject.Commit], shell);
    shell.echo(
      `<<< Checked out commitish from the CLI: '${versionObject.Commit}'.`
    );
  } else {
    shell.echo(`WARN: no 'git checkout'. Generating from the HEAD revision.`);
  }

  shell.echo('>>> Generating TS/JS API from:');
  exec('git', ['-C', repository, 'rev-parse', '--abbrev-ref', 'HEAD'], shell);

  const rpc = path.join(repository, 'rpc');
  const out = path.join(__dirname, '..', 'src', 'node', 'cli-protocol');
  shell.mkdir('-p', out);

  const protos = await new Promise((resolve) =>
    glob('**/*.proto', { cwd: rpc }, (error, matches) => {
      if (error) {
        shell.echo(error.stack ?? error.message);
        resolve([]);
        return;
      }
      resolve(matches.map((filename) => path.join(rpc, filename)));
    })
  );
  if (!protos || protos.length === 0) {
    shell.echo(`Could not find any .proto files under ${rpc}.`);
    shell.exit(1);
  }

  // Generate JS code from the `.proto` files.

  exec(
    'grpc_tools_node_protoc',
    [
      `--js_out=import_style=commonjs,binary:${out}`,
      `--grpc_out=generate_package_definition:${out}`,
      '-I',
      rpc,
      ...protos,
    ],
    shell
  );

  // Generate the `.d.ts` files for JS.
  exec(
    path.join(protoc, `protoc${platform === 'win32' ? '.exe' : ''}`),
    [
      `--plugin=protoc-gen-ts=${path.resolve(
        __dirname,
        '..',
        'node_modules',
        '.bin',
        `protoc-gen-ts${platform === 'win32' ? '.cmd' : ''}`
      )}`,
      `--ts_out=generate_package_definition:${out}`,
      '-I',
      rpc,
      ...protos,
    ],
    shell
  );

  shell.echo('<<< Generation was successful.');
})();
