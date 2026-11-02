export interface AuditActionMeta {
  label: string;
  category: 'auth' | 'recording' | 'video' | 'user' | 'storage' | 'retention';
}

const AUDIT_ACTION_MAP: Record<string, AuditActionMeta> = {
  // Đăng nhập & Bảo mật
  'auth.login': { label: 'Đăng nhập hệ thống', category: 'auth' },
  'auth.login.2fa_required': { label: 'Yêu cầu nhập mã bảo mật 2 lớp', category: 'auth' },
  'auth.login_2fa': { label: 'Xác minh đăng nhập 2 lớp', category: 'auth' },
  'auth.logout': { label: 'Đăng xuất tài khoản', category: 'auth' },
  'auth.register': { label: 'Đăng ký tài khoản nhân viên mới', category: 'auth' },
  'auth.forgot_password': { label: 'Yêu cầu lấy lại mật khẩu', category: 'auth' },
  'auth.reset_password': { label: 'Đặt lại mật khẩu mới', category: 'auth' },
  'auth.profile_updated': { label: 'Cập nhật hồ sơ & kho mặc định cá nhân', category: 'auth' },
  'auth.change_password': { label: 'Tự đổi mật khẩu tài khoản', category: 'auth' },
  'auth.mfa.setup': { label: 'Khởi tạo cài đặt bảo mật 2 lớp', category: 'auth' },
  'auth.mfa.enable': { label: 'Bật bảo mật 2 lớp thành công', category: 'auth' },
  'auth.mfa.disable': { label: 'Tắt bảo mật 2 lớp', category: 'auth' },
  'auth.mfa.regenerate_recovery_codes': {
    label: 'Tạo lại bộ mã khôi phục dự phòng',
    category: 'auth'
  },

  // Quét & Quay đóng gói
  'recording.create': { label: 'Tạo phiên quay đơn hàng', category: 'recording' },
  'recording.created': { label: 'Tạo phiên quay đơn hàng', category: 'recording' },
  'recording.manual_code': { label: 'Nhập mã vận đơn bằng tay', category: 'recording' },
  'video.import': { label: 'Tải tệp video quay sẵn lên', category: 'recording' },
  'video.import_created': { label: 'Tạo đơn từ tệp video quay sẵn', category: 'recording' },
  'video.upload': { label: 'Gửi dữ liệu video lên máy chủ', category: 'recording' },
  'video.upload_session': { label: 'Mở phiên truyền tải video', category: 'recording' },

  // Lưu trữ, Xem & Bảo vệ bằng chứng
  'video.stored': { label: 'Lưu trữ video hoàn tất', category: 'video' },
  'video.storage_failed': { label: 'Lỗi khi lưu video vào kho', category: 'video' },
  'video.retry_storage': { label: 'Thử lưu lại video vào kho', category: 'video' },
  'video.preview_ready': { label: 'Tạo xong bản xem nhanh MP4', category: 'video' },
  'video.preview_failed': { label: 'Chưa tạo được bản xem nhanh MP4', category: 'video' },
  'video.list': { label: 'Tra cứu danh sách video', category: 'video' },
  'video.view': { label: 'Mở xem thông tin video', category: 'video' },
  'video.stream': { label: 'Phát xem video trực tuyến', category: 'video' },
  'video.download': { label: 'Tải xuống tệp video gốc', category: 'video' },
  'video.note': { label: 'Ghi chú đối chiếu đơn hàng', category: 'video' },
  'video.note_added': { label: 'Thêm ghi chú đối chiếu mới', category: 'video' },
  'video.hold': { label: 'Thao tác khóa giữ bằng chứng', category: 'video' },
  'video.hold_updated': { label: 'Cập nhật khóa giữ bằng chứng', category: 'video' },
  'video.delete.request': { label: 'Gửi yêu cầu xóa video', category: 'video' },
  'video.delete_request_created': { label: 'Tạo yêu cầu xóa video', category: 'video' },
  'video.delete_request_blocked_hold': {
    label: 'Chặn yêu cầu xóa (đang khóa bằng chứng)',
    category: 'video'
  },
  'video.deletion_requests.list': { label: 'Xem danh sách chờ duyệt xóa', category: 'video' },
  'video.delete.approve': { label: 'Duyệt yêu cầu xóa video', category: 'video' },
  'video.delete_request_approve': { label: 'Phê duyệt xóa video khỏi thư viện', category: 'video' },
  'video.delete_approve_blocked_hold': {
    label: 'Chặn duyệt xóa (đang khóa bằng chứng)',
    category: 'video'
  },
  'video.delete_request_reject': { label: 'Từ chối yêu cầu xóa video', category: 'video' },
  'video.delete_request_rejected': { label: 'Đã từ chối yêu cầu xóa video', category: 'video' },
  'video.soft_deleted': { label: 'Đã ẩn video khỏi thư viện tra cứu', category: 'video' },

  // Quản trị nhân sự & Vai trò
  'admin.users.list': { label: 'Xem danh sách tài khoản nhân sự', category: 'user' },
  'admin.user.create': { label: 'Tạo trực tiếp tài khoản nhân viên mới', category: 'user' },
  'admin.user.approve': { label: 'Duyệt kích hoạt tài khoản nhân viên', category: 'user' },
  'admin.user.update_profile': {
    label: 'Cập nhật thông tin & kho mặc định nhân viên',
    category: 'user'
  },
  'admin.user.update_grants': { label: 'Cập nhật phân quyền Shop / Kho', category: 'user' },
  'admin.user.lock': { label: 'Khóa tài khoản nhân viên', category: 'user' },
  'admin.user.unlock': { label: 'Mở khóa tài khoản nhân viên', category: 'user' },
  'admin.user.revoke_sessions': { label: 'Đăng xuất tài khoản khỏi mọi thiết bị', category: 'user' },
  'admin.user.set_password': {
    label: 'Đặt mật khẩu mới trực tiếp cho nhân viên',
    category: 'user'
  },
  'admin.user.initiate_password_reset': {
    label: 'Cấp mã đặt lại mật khẩu cho nhân viên',
    category: 'user'
  },
  'admin.role.create': { label: 'Tạo vai trò tùy chỉnh mới', category: 'user' },
  'admin.role.update': { label: 'Cập nhật quyền của vai trò tùy chỉnh', category: 'user' },
  'system.bootstrap_superadmin': { label: 'Khởi tạo quản trị viên cao nhất', category: 'user' },

  // Cấu hình Kho lưu trữ, Shop & Nhật ký
  'admin.storage.view': { label: 'Xem cấu hình kho lưu trữ', category: 'storage' },
  'admin.storage.update': { label: 'Cập nhật cấu hình kho lưu trữ & hạn lưu', category: 'storage' },
  'admin.storage.health_check': { label: 'Kiểm tra kết nối ổ đĩa kho lưu trữ', category: 'storage' },
  'admin.warehouses.overview': { label: 'Xem danh sách quản lý Shop & Kho', category: 'storage' },
  'admin.shop.create': { label: 'Thêm Shop bán hàng mới', category: 'storage' },
  'admin.shop.update': { label: 'Cập nhật thông tin & trạng thái Shop', category: 'storage' },
  'admin.warehouse.create': { label: 'Thêm Kho đóng gói mới', category: 'storage' },
  'admin.warehouse.update': {
    label: 'Cập nhật thông tin & trạng thái Kho đóng gói',
    category: 'storage'
  },
  'admin.station.create': { label: 'Thêm bàn đóng gói mới', category: 'storage' },
  'admin.station.update': {
    label: 'Cập nhật thông tin & trạng thái bàn đóng gói',
    category: 'storage'
  },
  'admin.audit.view': { label: 'Truy cập nhật ký hoạt động', category: 'storage' },

  // Tự động dọn dẹp theo thời hạn
  'retention.deleted': { label: 'Tự động dọn video quá hạn lưu trữ', category: 'retention' },
  'retention.skipped_hold': {
    label: 'Giữ lại video quá hạn do đang khóa bằng chứng',
    category: 'retention'
  },
  'retention.delete_failed': { label: 'Lỗi khi tự động dọn video quá hạn', category: 'retention' }
};

const ENTITY_TYPE_LABELS: Record<string, string> = {
  Recording: 'Video đơn hàng',
  VideoAsset: 'Tệp video',
  VideoNote: 'Ghi chú đơn hàng',
  DeletionRequest: 'Yêu cầu xóa video',
  UploadSession: 'Phiên tải lên',
  User: 'Tài khoản nhân sự',
  ApplicationUser: 'Tài khoản nhân sự',
  UserScopeGrant: 'Phân quyền nhân sự',
  Role: 'Vai trò quyền hạn',
  ApplicationRole: 'Vai trò quyền hạn',
  StorageProfile: 'Cấu hình kho lưu trữ',
  Shop: 'Shop bán hàng',
  Warehouse: 'Kho đóng gói',
  PackingStation: 'Bàn đóng gói',
  AuditEvent: 'Nhật ký hoạt động'
};

const METADATA_KEY_LABELS: Record<string, string> = {
  trackingNumber: 'Mã vận đơn',
  carrierCode: 'Đơn vị vận chuyển',
  tikTokOrderId: 'Mã đơn TikTok',
  reason: 'Lý do',
  manualEntryReason: 'Lý do nhập tay',
  reviewNote: 'Ghi chú người duyệt',
  hold: 'Khóa bằng chứng',
  holdReason: 'Lý do khóa',
  isManualEntry: 'Nhập mã thủ công',
  source: 'Nguồn video',
  captureStatus: 'Trạng thái quay',
  storageStatus: 'Trạng thái lưu',
  storageMode: 'Chế độ lưu trữ',
  fileName: 'Tên tệp',
  originalFileName: 'Tên tệp gốc',
  sizeBytes: 'Dung lượng (bytes)',
  durationSeconds: 'Thời lượng (giây)',
  roleName: 'Vai trò',
  name: 'Tên',
  code: 'Mã',
  email: 'Email',
  targetEmail: 'Tài khoản đích',
  scopeType: 'Phạm vi',
  retentionEnabled: 'Tự động xóa theo hạn',
  retentionDays: 'Số ngày lưu giữ',
  errorCode: 'Mã cảnh báo'
};

export interface AuditFilterOption {
  value: string;
  label: string;
}

export const AUDIT_ACTION_FILTER_OPTIONS: AuditFilterOption[] = [
  { value: '', label: 'Tất cả nhóm hoạt động' },
  { value: 'auth.', label: 'Đăng nhập, Đăng ký & Bảo mật 2 lớp' },
  { value: 'recording.', label: 'Quét mã & Nhập mã vận đơn' },
  { value: 'video.stored', label: 'Lưu video hoàn tất' },
  { value: 'video.download', label: 'Tải xuống tệp video gốc' },
  { value: 'video.hold', label: 'Khóa / Mở khóa giữ bằng chứng' },
  { value: 'video.delete', label: 'Yêu cầu & Phê duyệt xóa video' },
  { value: 'video.note', label: 'Thêm ghi chú đối chiếu' },
  { value: 'video.import', label: 'Tải tệp video quay sẵn' },
  { value: 'admin.user.', label: 'Quản lý tài khoản & Phân quyền nhân sự' },
  { value: 'admin.role.', label: 'Tạo & Sửa vai trò quyền hạn' },
  { value: 'admin.shop.', label: 'Tạo & Cập nhật Shop bán hàng' },
  { value: 'admin.warehouse.', label: 'Tạo & Cập nhật Kho đóng gói' },
  { value: 'admin.station.', label: 'Tạo & Cập nhật Bàn đóng gói' },
  { value: 'admin.storage.', label: 'Cấu hình ổ lưu trữ & Kiểm tra kết nối' },
  { value: 'retention.', label: 'Tự động dọn dẹp theo thời hạn' }
];

export const AUDIT_ENTITY_FILTER_OPTIONS: AuditFilterOption[] = [
  { value: '', label: 'Tất cả loại đối tượng' },
  { value: 'Recording', label: 'Video đơn hàng' },
  { value: 'DeletionRequest', label: 'Yêu cầu xóa video' },
  { value: 'VideoNote', label: 'Ghi chú đơn hàng' },
  { value: 'User', label: 'Tài khoản nhân sự' },
  { value: 'Role', label: 'Vai trò quyền hạn' },
  { value: 'Shop', label: 'Shop bán hàng' },
  { value: 'Warehouse', label: 'Kho đóng gói' },
  { value: 'PackingStation', label: 'Bàn đóng gói' },
  { value: 'StorageProfile', label: 'Cấu hình kho lưu trữ' }
];

export function getAuditActionLabel(actionCode: string): AuditActionMeta {
  const exact = AUDIT_ACTION_MAP[actionCode];
  if (exact) {
    return exact;
  }
  if (actionCode.startsWith('auth.')) {
    return { label: `Tài khoản & Đăng nhập (${actionCode})`, category: 'auth' };
  }
  if (actionCode.startsWith('recording.')) {
    return { label: `Quay đơn hàng (${actionCode})`, category: 'recording' };
  }
  if (actionCode.startsWith('video.')) {
    return { label: `Thao tác video (${actionCode})`, category: 'video' };
  }
  if (actionCode.startsWith('admin.user')) {
    return { label: `Quản lý nhân sự (${actionCode})`, category: 'user' };
  }
  if (actionCode.startsWith('admin.')) {
    return { label: `Quản trị hệ thống (${actionCode})`, category: 'storage' };
  }
  return { label: actionCode, category: 'storage' };
}

export function getAuditEntityLabel(entityType: string): string {
  return ENTITY_TYPE_LABELS[entityType] ?? entityType;
}

export interface ParsedMetadataField {
  key: string;
  label: string;
  value: string;
}

function formatMetadataPrimitive(val: unknown): string {
  if (val === true) return 'Có';
  if (val === false) return 'Không';
  if (val === null || val === undefined || val === '') return '—';
  if (Array.isArray(val)) {
    return val.map((item) => formatMetadataPrimitive(item)).join(', ');
  }
  if (typeof val === 'object') {
    return JSON.stringify(val);
  }
  const str = String(val);
  if (str === 'SynologyMounted') return 'Kho lưu trữ NAS';
  if (str === 'LocalDevelopment') return 'Lưu thử nghiệm cục bộ';
  if (str === 'Captured') return 'Hoàn chỉnh';
  if (str === 'Interrupted') return 'Bị gián đoạn';
  if (str === 'Imported') return 'Tệp quay sẵn';
  if (str === 'RecordedInBrowser') return 'Quay trực tiếp';
  return str;
}

export function extractFriendlyAuditMetadata(rawJson?: string | null): ParsedMetadataField[] {
  if (!rawJson) {
    return [];
  }
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return [];
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    const result: ParsedMetadataField[] = [];
    for (const [key, val] of entries) {
      if (val === null || val === undefined || val === '') {
        continue;
      }
      result.push({
        key,
        label: METADATA_KEY_LABELS[key] ?? key,
        value: formatMetadataPrimitive(val)
      });
    }
    return result.slice(0, 6);
  } catch {
    return [];
  }
}

