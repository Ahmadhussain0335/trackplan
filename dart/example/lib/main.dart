import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'analytics/analytics.g.dart';

void main() {
  // Add your real adapters here (Firebase, PostHog, your own backend).
  // DebugAnalyticsAdapter prints full payloads, so it is limited to debug
  // builds: payloads may contain identifiers that count as personal data.
  final analytics = Analytics([
    if (kDebugMode) DebugAnalyticsAdapter(debugPrint),
  ]);
  runApp(ShopApp(analytics: analytics));
}

/// A tiny shop with two screens' worth of events.
class ShopApp extends StatelessWidget {
  /// Creates the app. [analytics] is injected so tests can record events.
  const ShopApp({super.key, required this.analytics});

  /// Generated, type-safe analytics.
  final Analytics analytics;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'trackplan example',
      home: ProductListPage(analytics: analytics),
    );
  }
}

/// A list of products; tapping one tracks `product_viewed`, buying one
/// tracks `checkout_completed`.
class ProductListPage extends StatelessWidget {
  /// Creates the page.
  const ProductListPage({super.key, required this.analytics});

  /// Generated, type-safe analytics.
  final Analytics analytics;

  static const _products = [
    (id: 'P-100', name: 'Coffee beans', price: 12.5),
    (id: 'P-200', name: 'Tea leaves', price: 8.0),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Shop')),
      body: ListView.builder(
        itemCount: _products.length,
        itemBuilder: (context, index) {
          final product = _products[index];
          return ListTile(
            title: Text(product.name),
            subtitle: Text('${product.price}'),
            onTap: () =>
                analytics.productViewed(productId: product.id, position: index),
            trailing: TextButton(
              onPressed: () => analytics.checkoutCompleted(
                orderId: 'order-${product.id}',
                total: product.price,
                paymentMethod: PaymentMethod.card,
              ),
              child: Text('Buy ${product.name}'),
            ),
          );
        },
      ),
    );
  }
}
