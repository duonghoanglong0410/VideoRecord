import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Clock, LogOut, RefreshCw } from 'lucide-react';
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
        setStatusNotice('Tài khoản vẫn đang chờ Quản lý kích hoạt.');
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
            <span className="brand-badge">
              <Clock className="h-3.5 w-3.5" aria-hidden="true" />
              Chờ phê duyệt
            </span>
            <h1 className="brand-title">Tài khoản đang chờ phê duyệt</h1>
            <p className="brand-subtitle">
              Xin chào <strong>{user.fullName}</strong> ({user.email}).
            </p>
          </div>

          <div className="alert alert-info">
            Bạn đã đăng ký thành công. Vui lòng báo <strong>Quản lý Shop</strong> hoặc{' '}
            <strong>Quản trị viên</strong> mở mục <em>Nhân sự</em> để duyệt tài khoản và chọn
            Shop/Kho làm việc cho bạn.
          </div>

          {statusNotice && (
            <div className="alert alert-warning" role="status">
              {statusNotice}
            </div>
          )}

          <div className="flex flex-col gap-2.5">
            <button
              type="button"
              className="btn btn-primary btn-full"
              onClick={() => void handleCheckStatus()}
              disabled={isChecking}
            >
              <RefreshCw
                className={`h-4 w-4 ${isChecking ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              {isChecking ? 'Đang kiểm tra...' : 'Kiểm tra lại trạng thái duyệt'}
            </button>

            <button
              type="button"
              className="btn btn-outline btn-full"
              onClick={() => void handleLogout()}
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              Đăng xuất
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
