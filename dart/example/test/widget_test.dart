import 'package:flutter_test/flutter_test.dart';
import 'package:trackplan_example/analytics/analytics.g.dart';
import 'package:trackplan_example/main.dart';

void main() {
  testWidgets('tapping a product and buying it tracks both events', (
    tester,
  ) async {
    final recorder = RecordingAnalyticsAdapter();
    await tester.pumpWidget(ShopApp(analytics: Analytics([recorder])));

    await tester.tap(find.text('Tea leaves'));
    await tester.tap(find.text('Buy Tea leaves'));

    expect(recorder.events.map((e) => e.event), [
      'product_viewed',
      'checkout_completed',
    ]);
    expect(recorder.events.first.params, {
      'product_id': 'P-200',
      'position': 1,
    });
    expect(recorder.events.last.params, {
      'order_id': 'order-P-200',
      'total': 8.0,
      'payment_method': 'card',
    });
  });
}
