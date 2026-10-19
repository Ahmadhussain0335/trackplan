import {
  type AnalyticsAdapter,
  type AnalyticsParams,
  Analytics,
  DebugAnalyticsAdapter,
  RecordingAnalyticsAdapter,
} from './analytics/analytics.js';

/**
 * Sends events to your own collector. In a browser, `navigator.sendBeacon`
 * keeps working while the page unloads. Not used by default: set
 * COLLECTOR_URL to an HTTPS endpoint you own to try it.
 */
class BeaconAdapter implements AnalyticsAdapter {
  private readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  track(event: string, params: AnalyticsParams): void {
    const body = JSON.stringify({ event, params });
    if (typeof navigator !== 'undefined' && 'sendBeacon' in navigator) {
      navigator.sendBeacon(this.url, body);
    } else {
      void fetch(this.url, { method: 'POST', body, keepalive: true }).catch((error: unknown) => {
        console.error('Analytics request failed:', error);
      });
    }
  }
}

const recorder = new RecordingAnalyticsAdapter();
const adapters: AnalyticsAdapter[] = [new DebugAnalyticsAdapter(console.log), recorder];
const collector = process.env['COLLECTOR_URL'];
if (collector?.startsWith('https://')) adapters.push(new BeaconAdapter(collector));

const analytics = new Analytics(adapters);

analytics.productViewed({ productId: 'P-100', position: 0 });
analytics.checkoutCompleted({ orderId: 'A12', total: 12.5, paymentMethod: 'card' });

// A typo or a missing param is a compile error:
// analytics.chekoutCompleted({ orderId: 'A12' });

console.log(`Recorded ${recorder.events.length} events.`);
