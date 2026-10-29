import { Link } from 'react-router-dom';
import { useAuth } from '../../app/authStore';
import { Permissions } from '../../app/types';

export function DashboardPlaceholderView() {
  const { user, runtimeConfig, hasPermission } = useAuth();

  return (
    <div>
      <div className="surface-card">
        <h1 style={{ marginTop: 0, fontSize: '1.35rem' }}>
          Bảng điều khiển vận hành
        </h1>
        <p style={{ color: 'var(--color-text-muted)', marginTop: 4 }}>
          Xin chào <strong>{user?.fullName}</strong>. Tài khoản của bạn đang ở trạng thái{' '}
          <strong>Hoạt động</strong>.
        </p>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
          {hasPermission(Permissions.RecordingCreate) && (
            <Link to="/record" className="btn btn-primary">
              Mở màn hình Quay đóng gói
            </Link>
          )}
          {hasPermission(Permissions.VideoView) && (
            <Link to="/videos" className="btn btn-navy">
              Tra cứu Video đóng gói
            </Link>
          )}
          <Link to="/security/mfa" className="btn btn-outline">
            Thiết lập bảo mật 2FA
          </Link>
        </div>
      </div>

      <div className="surface-card">
        <h2 style={{ marginTop: 0, fontSize: '1.1rem' }}>Phạm vi quyền được cấp hiện tại</h2>
        {user?.grants && user.grants.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {user.grants.map((g) => (
              <li key={g.id} style={{ marginBottom: 6 }}>
                Vai trò <strong>{g.roleName}</strong> — Phạm vi: <strong>{g.scopeType}</strong>
                {g.shopName ? ` (${g.shopName}` : ''}
                {g.warehouseName ? ` / ${g.warehouseName}` : ''}
                {g.shopName ? ')' : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p style={{ color: 'var(--color-text-muted)', margin: 0 }}>
            Tài khoản chưa được phân bổ phạm vi Shop hoặc Kho cụ thể.
          </p>
        )}

        {runtimeConfig && (
          <p style={{ marginTop: 14, marginBottom: 0, fontSize: '0.88rem', color: 'var(--color-text-muted)' }}>
            Giới hạn phiên quay: tối đa {Math.round(runtimeConfig.maxRecordingSeconds / 60)} phút •{' '}
            {Math.round(runtimeConfig.maxUploadBytes / (1024 * 1024))} MiB/video • tối đa{' '}
            {runtimeConfig.maxLocalPendingRecordings} bản ghi chờ trên thiết bị.
          </p>
        )}
      </div>
    </div>
  );
}

interface ModulePlaceholderProps {
  title: string;
  description: string;
  phaseNote: string;
}

function ModuleRoutePlaceholder({ title, description, phaseNote }: ModulePlaceholderProps) {
  return (
    <div className="surface-card">
      <h1 style={{ marginTop: 0, fontSize: '1.3rem' }}>{title}</h1>
      <p style={{ color: 'var(--color-text-muted)' }}>{description}</p>
      <div className="alert alert-info" style={{ marginBottom: 0 }}>
        {phaseNote}
      </div>
    </div>
  );
}

export function RecordingPlaceholderView() {
  return (
    <ModuleRoutePlaceholder
      title="Quay đóng gói đơn hàng"
      description="Quét mã vận đơn trên tem đơn hàng và ghi hình quá trình đóng gói trực tiếp từ camera."
      phaseNote="Khung định tuyến sẵn sàng cho Giai đoạn 2 (Quét mã ZXing, MediaRecorder và lưu tạm IndexedDB)."
    />
  );
}

export function UploadQueuePlaceholderView() {
  return (
    <ModuleRoutePlaceholder
      title="Hàng đợi tải lên từ thiết bị"
      description="Theo dõi tiến độ tải lên có thể tiếp tục (tus) và trạng thái xác minh lưu trữ."
      phaseNote="Khung định tuyến sẵn sàng cho Giai đoạn 2 & 3 (IndexedDB manifest + tus resumable upload)."
    />
  );
}

export function VideosPlaceholderView() {
  return (
    <ModuleRoutePlaceholder
      title="Danh sách & Tra cứu Video"
      description="Tìm kiếm theo mã vận đơn, lọc theo Shop/Kho/ngày quay và phát video trực tuyến."
      phaseNote="Khung định tuyến sẵn sàng cho Giai đoạn 4 (Tra cứu phân trang theo scope và phát HTTP Range)."
    />
  );
}

export function AdminUsersPlaceholderView() {
  return (
    <ModuleRoutePlaceholder
      title="Quản trị tài khoản & Phạm vi quyền"
      description="Phê duyệt tài khoản mới, gán vai trò theo Shop/Kho, khóa tài khoản và thu hồi phiên đăng nhập."
      phaseNote="API nền tảng /api/admin/users đã hoạt động; giao diện quản trị chi tiết hoàn thiện ở Giai đoạn 4."
    />
  );
}

export function AdminRolesPlaceholderView() {
  return (
    <ModuleRoutePlaceholder
      title="Quản trị Vai trò & Ma trận Quyền"
      description="Xem 6 vai trò mặc định và quản lý vai trò tùy chỉnh trong giới hạn trần quyền hạn (Grant Ceiling)."
      phaseNote="API nền tảng /api/admin/roles & /api/admin/permissions đã hoạt động; giao diện ma trận hoàn thiện ở Giai đoạn 4."
    />
  );
}

export function AdminStoragePlaceholderView() {
  return (
    <ModuleRoutePlaceholder
      title="Cấu hình Lưu trữ & Chính sách Lưu giữ"
      description="Kiểm tra kết nối vùng lưu trữ, thư mục con cho phép và cấu hình thời hạn lưu giữ video."
      phaseNote="Khung định tuyến sẵn sàng cho Giai đoạn 3 & 4."
    />
  );
}

export function AdminAuditPlaceholderView() {
  return (
    <ModuleRoutePlaceholder
      title="Nhật ký Kiểm toán (Audit Log)"
      description="Tra cứu lịch sử đăng nhập, thay đổi phân quyền và thao tác dữ liệu theo phạm vi được cấp."
      phaseNote="Bộ ghi nhật ký bất biến AuditLogger đã hoạt động; giao diện bộ lọc hoàn thiện ở Giai đoạn 4."
    />
  );
}

