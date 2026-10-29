import { describe, expect, it, vi } from 'vitest';
import {
  DuplicateScanDebouncer,
  parseTrackingCode
} from '../../src/features/recording/trackingParser';

describe('Phase 2 Frontend Tracking Parser & Duplicate Debouncer', () => {
  it('preserves leading zeros and original casing for plain 1D carrier codes', () => {
    const leadingZero = parseTrackingCode('00123456789', 'OneDimensional');
    expect(leadingZero.isValid).toBe(true);
    expect(leadingZero.trackingNumber).toBe('00123456789');
    expect(leadingZero.tikTokOrderId).toBeNull();

    const mixedCase = parseTrackingCode('SPXVN048291aBc', 'OneDimensional');
    expect(mixedCase.isValid).toBe(true);
    expect(mixedCase.trackingNumber).toBe('SPXVN048291aBc');
  });

  it('rejects QR URLs and custom URI schemes without guessing codes or making network calls', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const urls = [
      'https://www.tiktok.com/@shop/order/0012345678',
      'http://192.168.1.25/track?waybill=SPXVN001234',
      'tiktok://order/detail?tracking_number=00998877',
      'javascript:alert(1)',
      'www.spx.vn/track/SPXVN00123456'
    ];

    for (const rawUrl of urls) {
      const res = parseTrackingCode(rawUrl, 'QrCode');
      expect(res.isValid).toBe(false);
      expect(res.trackingNumber).toBeNull();
      expect(res.errorCode).toBe('UNRECOGNIZED_QR_PAYLOAD');
      expect(res.errorMessage).toMatch(/không tự truy cập URL|không.*suy đoán/i);
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('extracts structured JSON QR trackingNumber separately from tikTokOrderId and rejects numeric tracking values', () => {
    const validJson = JSON.stringify({
      tracking_number: '0099887766aB',
      carrier_code: 'JT-VN',
      tiktok_order_id: '5771234567890'
    });

    const parsed = parseTrackingCode(validJson, 'QrCode');
    expect(parsed.isValid).toBe(true);
    expect(parsed.trackingNumber).toBe('0099887766aB');
    expect(parsed.carrierCode).toBe('JT-VN');
    expect(parsed.tikTokOrderId).toBe('5771234567890');
    expect(parsed.trackingNumber).not.toBe(parsed.tikTokOrderId);

    const numericJson = '{"tracking_number": 12345678}';
    const numericParsed = parseTrackingCode(numericJson, 'QrCode');
    expect(numericParsed.isValid).toBe(false);
    expect(numericParsed.errorCode).toBe('UNRECOGNIZED_QR_PAYLOAD');

    const orderOnlyJson = JSON.stringify({ tiktok_order_id: '5771234567890' });
    const orderOnlyParsed = parseTrackingCode(orderOnlyJson, 'QrCode');
    expect(orderOnlyParsed.isValid).toBe(false);
    expect(orderOnlyParsed.trackingNumber).toBeNull();
    expect(orderOnlyParsed.errorCode).toBe('UNRECOGNIZED_QR_PAYLOAD');
  });

  it('rejects path traversal, control characters, shell metacharacters, and invalid lengths', () => {
    const dangerousInputs = [
      '../etc/passwd',
      '..\\Windows\\System32',
      'SPX..001234',
      'SPX%2e%2e001234',
      'ShopA/001234',
      '0012\u00003456',
      '0012\n3456',
      '0012\u007f3456',
      '$(whoami)',
      '`id`',
      'SPX123;rm',
      'AB1',
      '0' + 'A'.repeat(128) // 129 chars
    ];

    for (const bad of dangerousInputs) {
      const res = parseTrackingCode(bad, 'OneDimensional');
      expect(res.isValid).toBe(false);
      expect(res.trackingNumber).toBeNull();
    }
  });

  it('debounces identical consecutive scans within 2.5s while allowing distinct codes or post-window scans', () => {
    const debouncer = new DuplicateScanDebouncer(2500);

    expect(debouncer.shouldProcess('00123456', 1000)).toBe(true);
    expect(debouncer.shouldProcess('00123456', 1800)).toBe(false);
    expect(debouncer.shouldProcess('00123456', 3499)).toBe(false);

    // Distinct code within 2.5s is processed immediately
    expect(debouncer.shouldProcess('00999999', 2000)).toBe(true);
    expect(debouncer.shouldProcess('00999999', 3000)).toBe(false);

    // Same code after 2.5s window is allowed again
    expect(debouncer.shouldProcess('00999999', 4600)).toBe(true);

    // Reset clears debounce state immediately
    debouncer.reset();
    expect(debouncer.shouldProcess('00999999', 4650)).toBe(true);
  });
});

