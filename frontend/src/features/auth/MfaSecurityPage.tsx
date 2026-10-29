import { useState, type FormEvent } from 'react';
import { apiRequest, ApiRequestError } from '../../app/apiClient';
import { useAuth } from '../../app/authStore';
import type { MfaEnableResponse, MfaSetupResponse } from '../../app/types';

export function MfaSecurityPage() {
  const { user, refreshMe } = useAuth();

  const [setupData, setSetupData] = useState<MfaSetupResponse | null>(null);
  const [verificationCode, setVerificationCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const handleStartSetup = async () => {
    setErrorMessage(null);
    setSuccessMessage(null);
    setRecoveryCodes(null);
    setIsBusy(true);

    try {
      const res = await apiRequest<MfaSetupResponse>('/api/auth/mfa/setup', {
        method: 'POST',
        body: {}
      });
      setSetupData(res);
    } catch (err) {
      setErrorMessage(
        err instanceof ApiRequestError
          ? err.message
          : 'Không thể khởi tạo khóa xác thực hai lớp.'
      );
    } finally {
      setIsBusy(false);
    }
  };

  const handleEnable = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);
    setIsBusy(true);

    try {
      const res = await apiRequest<MfaEnableResponse>('/api/auth/mfa/enable', {
        method: 'POST',
        body: { code: verificationCode.trim() }
      });
      setRecoveryCodes(res.recoveryCodes);
      setSetupData(null);
      setVerificationCode('');
      setSuccessMessage('Đã bật xác thực hai lớp (TOTP) thành công.');
      await refreshMe();
    } catch (err) {
      setErrorMessage(
        err instanceof ApiRequestError ? err.message : 'Mã xác thực không hợp lệ.'
      );
    } finally {
      setIsBusy(false);
    }
  };

  const handleRegenerateCodes = async () => {
    if (!currentPassword) {
      setErrorMessage('Vui lòng nhập mật khẩu hiện tại để tạo bộ mã khôi phục mới.');
      return;
    }

    setErrorMessage(null);
    setSuccessMessage(null);
    setIsBusy(true);
    try {
      const res = await apiRequest<{ recoveryCodes: string[] }>(
        '/api/auth/mfa/recovery-codes',
        {
          method: 'POST',
          body: { currentPassword }
        }
      );
      setRecoveryCodes(res.recoveryCodes);
      setCurrentPassword('');
      setSuccessMessage('Đã tạo mới 10 mã khôi phục dự phòng. Các mã cũ không còn hiệu lực.');
    } catch (err) {
      setErrorMessage(
        err instanceof ApiRequestError ? err.message : 'Không thể tạo mã khôi phục.'
      );
    } finally {
      setIsBusy(false);
    }
  };

  const handleDisableMfa = async () => {
    if (!currentPassword) {
      setErrorMessage('Vui lòng nhập mật khẩu hiện tại để xác nhận tắt 2FA.');
      return;
    }

    setErrorMessage(null);
    setSuccessMessage(null);
    setIsBusy(true);
    try {
      await apiRequest('/api/auth/mfa/disable', {
        method: 'POST',
        body: { currentPassword }
      });
      setRecoveryCodes(null);
      setSetupData(null);
      setCurrentPassword('');
      setSuccessMessage('Đã tắt xác thực hai lớp cho tài khoản.');
      await refreshMe();
    } catch (err) {
      setErrorMessage(
        err instanceof ApiRequestError ? err.message : 'Không thể tắt xác thực hai lớp.'
      );
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div>
      <div className="surface-card">
        <h1 style={{ marginTop: 0, fontSize: '1.3rem' }}>
          Bảo mật tài khoản — Xác thực hai lớp (TOTP 2FA)
        </h1>
        <p style={{ color: 'var(--color-text-muted)' }}>
          Bảo vệ tài khoản quản trị và vận hành bằng ứng dụng Google Authenticator, Microsoft
          Authenticator hoặc ứng dụng TOTP tương thích chuẩn RFC 6238.
        </p>

        <div className={`alert ${user?.twoFactorEnabled ? 'alert-success' : 'alert-info'}`}>
          Trạng thái hiện tại:{' '}
          <strong>
            {user?.twoFactorEnabled ? 'ĐÃ BẬT xác thực 2 lớp' : 'CHƯA BẬT xác thực 2 lớp'}
          </strong>
        </div>

        {errorMessage && (
          <div className="alert alert-error" role="alert">
            {errorMessage}
          </div>
        )}

        {successMessage && (
          <div className="alert alert-success" role="status">
            {successMessage}
          </div>
        )}

        {recoveryCodes && recoveryCodes.length > 0 && (
          <div className="alert alert-warning">
            <strong>Lưu giữ ngay 10 mã khôi phục dự phòng (chỉ hiển thị một lần):</strong>
            <div className="recovery-grid">
              {recoveryCodes.map((code) => (
                <div key={code} className="code-box">
                  {code}
                </div>
              ))}
            </div>
          </div>
        )}

        {!user?.twoFactorEnabled && !setupData && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleStartSetup()}
            disabled={isBusy}
          >
            {isBusy ? 'Đang tạo khóa...' : 'Thiết lập xác thực hai lớp'}
          </button>
        )}

        {setupData && (
          <form onSubmit={(e) => void handleEnable(e)} style={{ marginTop: 16 }}>
            <div className="form-group">
              <span className="form-label">
                1. Nhập khóa thiết lập thủ công vào ứng dụng Authenticator:
              </span>
              <div className="code-box" data-testid="mfa-shared-key">
                {setupData.sharedKey}
              </div>
            </div>

            <div className="form-group">
              <span className="form-label">URI chuẩn OTPAuth (dành cho trình quản lý mã):</span>
              <div className="code-box" style={{ fontSize: '0.8rem' }}>
                {setupData.authenticatorUri}
              </div>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="mfa-verify-code">
                2. Nhập mã 6 chữ số hiển thị trên ứng dụng để kích hoạt:
              </label>
              <input
                id="mfa-verify-code"
                type="text"
                inputMode="numeric"
                className="form-input"
                required
                value={verificationCode}
                onChange={(e) => setVerificationCode(e.target.value)}
                placeholder="123456"
              />
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button type="submit" className="btn btn-primary" disabled={isBusy}>
                {isBusy ? 'Đang kích hoạt...' : 'Kích hoạt 2FA'}
              </button>
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => setSetupData(null)}
                disabled={isBusy}
              >
                Hủy
              </button>
            </div>
          </form>
        )}

        {user?.twoFactorEnabled && (
          <div style={{ marginTop: 20 }}>
            <div className="form-group">
              <label className="form-label" htmlFor="mfa-current-password">
                Nhập mật khẩu hiện tại để tạo lại mã khôi phục hoặc tắt 2FA
              </label>
              <input
                id="mfa-current-password"
                type="password"
                className="form-input"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Mật khẩu hiện tại"
              />
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-navy"
                onClick={() => void handleRegenerateCodes()}
                disabled={isBusy}
              >
                Tạo lại mã khôi phục dự phòng
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void handleDisableMfa()}
                disabled={isBusy}
              >
                Tắt xác thực hai lớp
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

