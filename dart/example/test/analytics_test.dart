import 'package:flutter_test/flutter_test.dart';
import 'package:trackplan_example/analytics/analytics.g.dart';

void main() {
  late RecordingAnalyticsAdapter recorder;
  late Analytics analytics;

  setUp(() {
    recorder = RecordingAnalyticsAdapter();
    analytics = Analytics([recorder]);
  });

  test('checkoutCompleted sends snake_case keys and the enum value', () {
    analytics.checkoutCompleted(
      orderId: 'A12',
      total: 50,
      paymentMethod: PaymentMethod.paypal,
    );

    final event = recorder.events.single;
    expect(event.event, 'checkout_completed');
    expect(event.params, {
      'order_id': 'A12',
      'total': 50.0,
      'payment_method': 'paypal',
    });
  });

  test('optional params are left out when null', () {
    analytics.productViewed(productId: 'P-1');

    expect(recorder.events.single.params, {'product_id': 'P-1'});
  });

  test('range checks from the plan fail in debug builds', () {
    expect(
      () => analytics.productViewed(productId: 'P-1', position: -1),
      throwsA(isA<AssertionError>()),
    );
  });

  test('adapters cannot change the params', () {
    analytics.productViewed(productId: 'P-1');

    expect(
      () => recorder.events.single.params['product_id'] = 'changed',
      throwsUnsupportedError,
    );
  });

  test('clear empties the recorded events', () {
    analytics.productViewed(productId: 'P-1');
    recorder.clear();

    expect(recorder.events, isEmpty);
  });
}
