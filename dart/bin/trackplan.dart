import 'dart:io';

import 'package:trackplan/src/cli.dart';

void main(List<String> arguments) {
  exitCode = runCli(
    arguments,
    cwd: Directory.current.path,
    out: stdout,
    err: stderr,
  );
}
