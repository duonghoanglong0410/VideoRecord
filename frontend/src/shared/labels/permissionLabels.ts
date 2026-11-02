export interface PermissionFriendlyInfo {
  label: string;
  group: 'packing' | 'video' | 'people' | 'system';
}

export const PERMISSION_GROUP_TITLES: Record<PermissionFriendlyInfo['group'], string> = {
  packing: '1. Quét mã & Quay đóng gói tại kho',
  video: '2. Tra cứu, Đối soát & Bảo vệ bằng chứng',
  people: '3. Quản lý Nhân sự & Phân quyền',
  system: '4. Cấu hình Kho lưu trữ & Nhật ký'
};

export const PERMISSION_FRIENDLY_MAP: Record<string, PermissionFriendlyInfo> = {
  'recording.create': {
    label: 'Quét mã vận đơn & Quay video đóng gói trực tiếp',
    group: 'packing'
  },
  'recording.manual_code': {
    label: 'Nhập mã vận đơn bằng tay (khi tem rách/mờ)',
    group: 'packing'
  },
  'video.upload': {
    label: 'Tự động gửi video từ thiết bị lên hệ thống',
    group: 'packing'
  },
  'video.import': {
    label: 'Tải lên tệp video đã quay sẵn bên ngoài',
    group: 'packing'
  },
  'video.view': {
    label: 'Tìm kiếm & Xem phát lại video bằng chứng',
    group: 'video'
  },
  'video.download': {
    label: 'Tải tệp video gốc về máy để gửi khiếu nại sàn',
    group: 'video'
  },
  'video.note': {
    label: 'Ghi chú nội bộ & thông tin khiếu nại vào đơn hàng',
    group: 'video'
  },
  'video.hold': {
    label: 'Bật / Gỡ chế độ Khóa giữ bằng chứng (chống xóa)',
    group: 'video'
  },
  'video.delete.request': {
    label: 'Gửi đề xuất xin xóa video quay nhầm/quay thử',
    group: 'video'
  },
  'video.delete.approve': {
    label: 'Phê duyệt hoặc từ chối yêu cầu xóa video',
    group: 'video'
  },
  'user.manage': {
    label: 'Duyệt nhân viên mới, khóa tài khoản & cấp lại mật khẩu',
    group: 'people'
  },
  'role.manage': {
    label: 'Tạo & chỉnh sửa các nhóm vai trò tùy chỉnh',
    group: 'people'
  },
  'storage.manage': {
    label: 'Quản lý Shop, Kho đóng gói & kết nối ổ đĩa lưu trữ',
    group: 'system'
  },
  'audit.view': {
    label: 'Xem lịch sử nhật ký hoạt động hệ thống',
    group: 'system'
  }
};

export const SYSTEM_ROLE_VIETNAMESE_TITLES: Record<string, string> = {
  SuperAdmin: 'Quản trị cao nhất',
  Admin: 'Quản lý Shop',
  ShopAdmin: 'Quản lý Shop',
  Manager: 'Quản lý Kho',
  Supervisor: 'Giám sát kho',
  Operator: 'Nhân viên đóng gói',
  Viewer: 'Nhân viên tra cứu',
  Auditor: 'Kiểm soát viên'
};

export function getFriendlyPermissionInfo(
  code: string,
  fallbackDescription?: string
): PermissionFriendlyInfo {
  return (
    PERMISSION_FRIENDLY_MAP[code] ?? {
      label: fallbackDescription || code,
      group: 'system'
    }
  );
}

