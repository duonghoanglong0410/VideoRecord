import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../../app/authStore';
import { StorageModeBanner } from '../../app/StorageModeBanner';

export function PendingApprovalPage() {
  const { user, runtimeConfig, refreshMe, logout } = useAuth();
  const navigate = useNavigate();
  const [isChecking, setIsChecking] = useState(false);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (user.approvalStatus === 'Active') {
    return <Navigate to="/" replace />;
  }

  const handleCheckStatus = async () => {
    setIsChecking(true);
    setStatusNotice(null);
    try {
      const updated = await refreshMe();
      if (updated?.approvalStatus === 'Active') {
        navigate('/', { replace: true });
      } else {
        setStatusNotice('Tài khoản vẫn đang ở trạng thái chờ Quản trị viên phê duyệt.');
      }
    } finally {
      setIsChecking(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="auth-shell">
      <StorageModeBanner storageMode={runtimeConfig?.storageMode} />

      <div className="auth-container">
        <div className="auth-card">
          <div className="brand-header">
            <span className="brand-badge">Chờ phê duyệt</span>
            <h1 className="brand-title">Tài khoản đang chờ phê duyệt</h1>
            <p className="brand-subtitle">
              Xin chào <strong>{user.fullName}</strong> ({user.email}).
            </p>
          </div>

          <div className="alert alert-info">
            Tài khoản của bạn đã được ghi nhận thành công nhưng chưa được cấp quyền truy cập dữ
            liệu nghiệp vụ. Vui lòng liên hệ Quản trị viên Shop hoặc Quản trị hệ thống để được
            phê duyệt và phân bổ Shop/Kho làm việc.
          </div>

          {statusNotice && (
            <div className="alert alert-warning" role="status">
              {statusNotice}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button
              type="button"
              className="btn btn-primary btn-full"
              onClick={() => void handleCheckStatus()}
              disabled={isChecking}
            >
              {isChecking ? 'Đang kiểm tra...' : 'Kiểm tra lại trạng thái duyệt'}
            </button>

            <button
              type="button"
              className="btn btn-outline btn-full"
              onClick={() => void handleLogout()}
            >
              Đăng xuất
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

