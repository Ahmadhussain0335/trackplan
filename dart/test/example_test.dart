import 'package:test/test.dart';
import 'package:trackplan/src/cli.dart';

void main() {
  test('the generated code of the example app is up to date', () {
    final out = StringBuffer();
    final err = StringBuffer();
    final code = runCli(['check'], cwd: 'example', out: out, err: err);
    expect(code, exitOk, reason: '$err');
  });
}
