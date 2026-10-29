import type { BarcodeFormatHint } from './recordingApi';

export const MIN_TRACKING_LENGTH = 4;
export const MAX_TRACKING_LENGTH = 128;
export const MAX_STRUCTURED_QR_LENGTH = 2048;
export const DEFAULT_DUPLICATE_SCAN_WINDOW_MS = 2500;

export interface ClientTrackingParseResult {
  isValid: boolean;
  trackingNumber: string | null;
  carrierCode: string | null;
  tikTokOrderId: string | null;
  matchedRule: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

const TRACKING_JSON_KEYS = [
  'tracking_number',
  'trackingNumber',
  'waybill_no',
  'waybillNo'
] as const;

const CARRIER_JSON_KEYS = [
  'carrier_code',
  'carrierCode',
  'shipping_provider',
  'shippingProvider'
] as const;

const TIKTOK_ORDER_JSON_KEYS = [
  'tiktok_order_id',
  'tiktokOrderId',
  'order_id',
  'orderId'
] as const;

const URI_SCHEME_REGEX = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const SPECIAL_URI_PREFIX_REGEX = /^(javascript|data|mailto|tel|blob|file|about):/i;
const VALID_PLAIN_TRACKING_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{2,126}[A-Za-z0-9]$/;
const SAFE_AUXILIARY_CODE_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COMPOSITE_KEY_VALUE_REGEX =
  /^[A-Za-z0-9_.-]+[:=][A-Za-z0-9_.-]+([&;|][A-Za-z0-9_.-]+[:=][A-Za-z0-9_.-]+)+$/;

const SHELL_METACHAR_SET = new Set([
  ';',
  '&',
  '|',
  '$',
  '`',
  '>',
  '<',
  '!',
  '*',
  '?',
  '"',
  "'",
  '(',
  ')',
  '{',
  '}',
  '[',
  ']'
]);

function failure(errorCode: string, errorMessage: string): ClientTrackingParseResult {
  return {
    isValid: false,
    trackingNumber: null,
    carrierCode: null,
    tikTokOrderId: null,
    matchedRule: null,
    errorCode,
    errorMessage
  };
}

function unrecognizedQrFailure(): ClientTrackingParseResult {
  return failure(
    'UNRECOGNIZED_QR_PAYLOAD',
    'Mã QR chứa liên kết web (URL) hoặc dữ liệu tổng hợp chưa được hỗ trợ. Hệ thống không tự truy cập URL hay suy đoán mã; vui lòng quét trực tiếp mã vạch (1D) hoặc mã vận đơn trên tem đơn hàng.'
  );
}

function containsDisallowedControlChars(
  input: string,
  allowJsonFormattingWhitespace: boolean
): boolean {
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code === 0x7f) {
      return true;
    }
    if (code <= 0x1f) {
      if (
        allowJsonFormattingWhitespace &&
        (code === 0x0d || code === 0x0a || code === 0x09)
      ) {
        continue;
      }
      return true;
    }
  }
  return false;
}

function looksLikeUrlOrUriScheme(input: string): boolean {
  if (URI_SCHEME_REGEX.test(input) || SPECIAL_URI_PREFIX_REGEX.test(input)) {
    return true;
  }

  if (
    input.toLowerCase().startsWith('www.') &&
    (input.includes('/') || input.includes('?'))
  ) {
    return true;
  }

  return false;
}

function containsTraversalOrPathSeparator(input: string): boolean {
  const lower = input.toLowerCase();
  return (
    input.includes('/') ||
    input.includes('\\') ||
    input.includes('..') ||
    lower.includes('%2e%2e') ||
    lower.includes('%2f') ||
    lower.includes('%5c')
  );
}

function containsShellMetacharacters(input: string): boolean {
  for (let i = 0; i < input.length; i += 1) {
    if (SHELL_METACHAR_SET.has(input[i])) {
      return true;
    }
  }
  return false;
}

function looksLikeUnrecognizedCompositeQr(
  input: string,
  formatHint: BarcodeFormatHint
): boolean {
  if (
    input.includes('$') ||
    input.includes('`') ||
    input.includes('<') ||
    input.includes('>')
  ) {
    return false;
  }

  if (COMPOSITE_KEY_VALUE_REGEX.test(input)) {
    return true;
  }

  if (
    formatHint === 'QrCode' &&
    (input.includes('\n') ||
      input.includes('\r') ||
      input.includes('=') ||
      input.includes('|') ||
      input.includes(':'))
  ) {
    return true;
  }

  return false;
}

function trimAsciiSpaces(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === ' ') {
    start += 1;
  }
  while (end > start && value[end - 1] === ' ') {
    end -= 1;
  }
  return value.slice(start, end);
}

function validatePlainTrackingCode(
  candidate: string,
  matchedRule: string
): ClientTrackingParseResult {
  if (containsDisallowedControlChars(candidate, false)) {
    return failure(
      'TRACKING_CONTROL_CHAR',
      'Mã vận đơn chứa ký tự điều khiển không hợp lệ.'
    );
  }

  if (candidate.length > MAX_TRACKING_LENGTH) {
    return failure(
      'TRACKING_TOO_LONG',
      `Mã vận đơn vượt quá độ dài tối đa ${MAX_TRACKING_LENGTH} ký tự.`
    );
  }

  if (containsTraversalOrPathSeparator(candidate)) {
    return failure(
      'TRACKING_PATH_TRAVERSAL',
      'Mã vận đơn chứa ký tự phân cách đường dẫn hoặc chuỗi điều hướng thư mục không được phép.'
    );
  }

  if (containsShellMetacharacters(candidate)) {
    return failure(
      'INVALID_TRACKING_CHARACTERS',
      'Mã vận đơn chứa ký tự đặc biệt không hợp lệ.'
    );
  }

  if (candidate.length < MIN_TRACKING_LENGTH) {
    return failure(
      'TRACKING_TOO_SHORT',
      `Mã vận đơn phải có ít nhất ${MIN_TRACKING_LENGTH} ký tự.`
    );
  }

  if (!VALID_PLAIN_TRACKING_REGEX.test(candidate)) {
    return failure(
      'INVALID_TRACKING_CHARACTERS',
      "Mã vận đơn chỉ cho phép chữ cái không dấu, chữ số và các ký tự '.', '-', '_' (bắt đầu và kết thúc bằng chữ hoặc số)."
    );
  }

  return {
    isValid: true,
    trackingNumber: candidate,
    carrierCode: null,
    tikTokOrderId: null,
    matchedRule,
    errorCode: null,
    errorMessage: null
  };
}

function extractExplicitStringProperty(
  record: Record<string, unknown>,
  keys: readonly string[]
): { found: boolean; value: string; nonStringFound: boolean } {
  let nonStringFound = false;

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      const val = record[key];
      if (val === null || val === undefined) {
        continue;
      }
      if (typeof val !== 'string') {
        nonStringFound = true;
        continue;
      }
      return { found: true, value: val, nonStringFound };
    }
  }

  return { found: false, value: '', nonStringFound };
}

function isSafeAuxiliaryCode(value: string, maxLen: number): boolean {
  return (
    value.length <= maxLen &&
    !containsDisallowedControlChars(value, false) &&
    !containsTraversalOrPathSeparator(value) &&
    SAFE_AUXILIARY_CODE_REGEX.test(value)
  );
}

function parseStructuredJsonPayload(jsonPayload: string): ClientTrackingParseResult {
  if (
    jsonPayload.length > MAX_STRUCTURED_QR_LENGTH ||
    !jsonPayload.startsWith('{') ||
    !jsonPayload.endsWith('}')
  ) {
    return unrecognizedQrFailure();
  }

  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(jsonPayload);
  } catch {
    return unrecognizedQrFailure();
  }

  if (!parsedUnknown || typeof parsedUnknown !== 'object' || Array.isArray(parsedUnknown)) {
    return unrecognizedQrFailure();
  }

  const record = parsedUnknown as Record<string, unknown>;
  const trackingProp = extractExplicitStringProperty(record, TRACKING_JSON_KEYS);

  if (!trackingProp.found) {
    if (trackingProp.nonStringFound) {
      return failure(
        'UNRECOGNIZED_QR_PAYLOAD',
        'Mã QR định dạng dữ liệu vận đơn dạng số thay vì chuỗi nên có nguy cơ mất số 0 ở đầu. Vui lòng quét trực tiếp mã vạch (1D) trên tem đơn hàng.'
      );
    }
    return unrecognizedQrFailure();
  }

  if (looksLikeUrlOrUriScheme(trackingProp.value)) {
    return unrecognizedQrFailure();
  }

  const validated = validatePlainTrackingCode(trackingProp.value, 'StructuredJsonQr');
  if (!validated.isValid) {
    return validated;
  }

  let carrierCode: string | null = null;
  const carrierProp = extractExplicitStringProperty(record, CARRIER_JSON_KEYS);
  if (carrierProp.found) {
    const trimmed = trimAsciiSpaces(carrierProp.value);
    if (trimmed.length > 0) {
      if (!isSafeAuxiliaryCode(trimmed, 32)) {
        return failure(
          'INVALID_CARRIER_CODE',
          'Thông tin đơn vị vận chuyển trong mã QR chứa ký tự không hợp lệ.'
        );
      }
      carrierCode = trimmed;
    }
  }

  let tikTokOrderId: string | null = null;
  const orderProp = extractExplicitStringProperty(record, TIKTOK_ORDER_JSON_KEYS);
  if (orderProp.found) {
    const trimmed = trimAsciiSpaces(orderProp.value);
    if (trimmed.length > 0) {
      if (!isSafeAuxiliaryCode(trimmed, 64)) {
        return failure(
          'INVALID_ORDER_ID',
          'Thông tin mã đơn hàng trong mã QR chứa ký tự không hợp lệ.'
        );
      }
      tikTokOrderId = trimmed;
    }
  }

  return {
    isValid: true,
    trackingNumber: validated.trackingNumber,
    carrierCode,
    tikTokOrderId,
    matchedRule: 'StructuredJsonQr',
    errorCode: null,
    errorMessage: null
  };
}

/**
 * Mirrors backend TrackingCodeParser validation for instant UI feedback without ever guessing
 * codes from URLs or making outbound network requests to scanned URLs.
 */
export function parseTrackingCode(
  rawInput: string | null | undefined,
  formatHint: BarcodeFormatHint = 'Unknown'
): ClientTrackingParseResult {
  if (rawInput === null || rawInput === undefined) {
    return failure('EMPTY_TRACKING_CODE', 'Mã vận đơn không được để trống.');
  }

  const spaceTrimmed = trimAsciiSpaces(rawInput);
  if (spaceTrimmed.length === 0) {
    return failure('EMPTY_TRACKING_CODE', 'Mã vận đơn không được để trống.');
  }

  const looksLikeJsonObject =
    spaceTrimmed.startsWith('{') && spaceTrimmed.endsWith('}');
  const allowMultilineQr = looksLikeJsonObject || formatHint === 'QrCode';

  if (containsDisallowedControlChars(rawInput, allowMultilineQr)) {
    return failure(
      'TRACKING_CONTROL_CHAR',
      'Mã quét chứa ký tự điều khiển không hợp lệ. Vui lòng quét lại đúng mã vận đơn.'
    );
  }

  if (looksLikeUrlOrUriScheme(spaceTrimmed)) {
    return unrecognizedQrFailure();
  }

  if (
    looksLikeJsonObject ||
    spaceTrimmed.startsWith('{') ||
    spaceTrimmed.startsWith('[')
  ) {
    return parseStructuredJsonPayload(spaceTrimmed);
  }

  if (
    !containsTraversalOrPathSeparator(spaceTrimmed) &&
    looksLikeUnrecognizedCompositeQr(spaceTrimmed, formatHint)
  ) {
    return unrecognizedQrFailure();
  }

  return validatePlainTrackingCode(spaceTrimmed, 'PlainCarrierCode');
}

/**
 * Suppresses repeated identical raw barcode scans within `windowMs` (default 2.5s)
 * so continuous camera frames do not trigger duplicate API calls or UI flicker.
 */
export class DuplicateScanDebouncer {
  private readonly windowMs: number;
  private lastPayload: string | null = null;
  private lastTimestampMs = 0;

  constructor(windowMs: number = DEFAULT_DUPLICATE_SCAN_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  public shouldProcess(rawPayload: string, nowMs: number = Date.now()): boolean {
    if (!rawPayload) {
      return false;
    }

    if (
      this.lastPayload !== null &&
      this.lastPayload === rawPayload &&
      nowMs - this.lastTimestampMs < this.windowMs
    ) {
      return false;
    }

    this.lastPayload = rawPayload;
    this.lastTimestampMs = nowMs;
    return true;
  }

  public reset(): void {
    this.lastPayload = null;
    this.lastTimestampMs = 0;
  }
}

