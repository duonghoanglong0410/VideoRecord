import { useState, type FormEvent } from 'react';
import {
  Check,
  CheckCircle2,
  Copy,
  KeyRound,
  ShieldAlert,
  ShieldCheck,
  Smartphone
} from 'lucide-react';
import { apiRequest, ApiRequestError } from '../../app/apiClient';
import { useAuth } from '../../app/authStore';
import type { MfaEnableResponse, MfaSetupResponse } from '../../app/types';
import { PageHeader } from '../../components/ui/PageHeader';

export function MfaSecurityPage() {
  const { user, refreshMe } = useAuth();

  const [setupData, setSetupData] = useState<MfaSetupResponse | null>(null);
  const [verificationCode, setVerificationCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [copiedKey, setCopiedKey] = useState(false);
  const [copiedRecovery, setCopiedRecovery] = useState(false);

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
          : 'Không thể khởi tạo khóa bảo mật 2 lớp.'
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
      setSuccessMessage('Đã bật bảo mật 2 lớp cho tài khoản thành công.');
      await refreshMe();
    } catch (err) {
      setErrorMessage(
        err instanceof ApiRequestError ? err.message : 'Mã xác thực 6 số chưa đúng.'
      );
    } finally {
      setIsBusy(false);
    }
  };

  const handleRegenerateCodes = async () => {
    if (!currentPassword) {
      setErrorMessage('Vui lòng nhập mật khẩu hiện tại để tạo bộ mã dự phòng mới.');
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
      setSuccessMessage('Đã tạo mới 10 mã dự phòng. Các mã cũ đã ngừng hiệu lực.');
    } catch (err) {
      setErrorMessage(
        err instanceof ApiRequestError ? err.message : 'Không thể tạo mã dự phòng.'
      );
    } finally {
      setIsBusy(false);
    }
  };

  const handleDisableMfa = async () => {
    if (!currentPassword) {
      setErrorMessage('Vui lòng nhập mật khẩu hiện tại để xác nhận tắt bảo mật 2 lớp.');
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
      setSuccessMessage('Đã tắt bảo mật 2 lớp cho tài khoản.');
      await refreshMe();
    } catch (err) {
      setErrorMessage(
        err instanceof ApiRequestError ? err.message : 'Không thể tắt bảo mật 2 lớp.'
      );
    } finally {
      setIsBusy(false);
    }
  };

  const copyText = async (text: string, kind: 'key' | 'recovery') => {
    try {
      await navigator.clipboard.writeText(text);
      if (kind === 'key') {
        setCopiedKey(true);
        setTimeout(() => setCopiedKey(false), 2000);
      } else {
        setCopiedRecovery(true);
        setTimeout(() => setCopiedRecovery(false), 2000);
      }
    } catch {
      // Ignore clipboard permission failure
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="surface-card">
        <PageHeader
          title="Bảo mật tài khoản 2 lớp"
          subtitle="Tăng thêm lớp mã 6 số trên điện thoại (Google Authenticator / Microsoft Authenticator) để chống lộ mật khẩu."
          badge={
            user?.twoFactorEnabled ? (
              <span className="status-pill status-pill-completed">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Đang bật
              </span>
            ) : (
              <span className="status-pill status-pill-muted">
                <ShieldAlert className="h-3.5 w-3.5" />
                Chưa bật
              </span>
            )
          }
        />

        {errorMessage && (
          <div className="alert alert-error mt-4 mb-0" role="alert">
            {errorMessage}
          </div>
        )}

        {successMessage && (
          <div className="alert alert-success mt-4 mb-0" role="status">
            {successMessage}
          </div>
        )}

        {recoveryCodes && recoveryCodes.length > 0 && (
          <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="text-sm text-amber-900">
                10 Mã dự phòng khi mất điện thoại (Chỉ hiện 1 lần duy nhất)
              </strong>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => void copyText(recoveryCodes.join('\n'), 'recovery')}
              >
                {copiedRecovery ? (
                  <Check className="h-4 w-4 text-emerald-700" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
                {copiedRecovery ? 'Đã sao chép' : 'Sao chép tất cả'}
              </button>
            </div>
            <div className="recovery-grid">
              {recoveryCodes.map((c) => (
                <div key={c} className="code-box bg-white text-center font-bold">
                  {c}
                </div>
              ))}
            </div>
            <p className="m-0 text-xs text-amber-900">
              Hãy lưu bộ mã này vào nơi an toàn. Mỗi mã dùng được 1 lần để đăng nhập khi bạn đổi điện thoại.
            </p>
          </div>
        )}

        {!user?.twoFactorEnabled ? (
          <div className="mt-5">
            {!setupData ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void handleStartSetup()}
                disabled={isBusy}
              >
                <Smartphone className="h-4 w-4" aria-hidden="true" />
                {isBusy ? 'Đang khởi tạo...' : 'Bắt đầu cài đặt bảo mật 2 lớp'}
              </button>
            ) : (
              <form
                onSubmit={(e) => void handleEnable(e)}
                className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4"
              >
                <div>
                  <div className="text-sm font-bold text-slate-900">
                    Bước 1: Mở ứng dụng Authenticator trên điện thoại và nhập khóa bên dưới
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <div className="code-box flex-1 bg-white font-bold">
                      {setupData.sharedKey}
                    </div>
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={() => void copyText(setupData.sharedKey, 'key')}
                    >
                      {copiedKey ? (
                        <Check className="h-4 w-4 text-emerald-700" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                      {copiedKey ? 'Đã chép' : 'Sao chép khóa'}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="form-label" htmlFor="mfa-verify-code">
                    Bước 2: Nhập 6 chữ số hiển thị trên ứng dụng điện thoại
                  </label>
                  <input
                    id="mfa-verify-code"
                    type="text"
                    inputMode="numeric"
                    className="form-input max-w-xs font-mono text-lg tracking-widest"
                    required
                    value={verificationCode}
                    onChange={(e) => setVerificationCode(e.target.value)}
                    placeholder="000000"
                  />
                </div>

                <button type="submit" className="btn btn-primary" disabled={isBusy}>
                  <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                  {isBusy ? 'Đang kích hoạt...' : 'Xác nhận & Bật bảo mật 2 lớp'}
                </button>
              </form>
            )}
          </div>
        ) : (
          <div className="mt-5 space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="form-group mb-0">
              <label className="form-label" htmlFor="mfa-current-password">
                Nhập mật khẩu hiện tại để tạo lại mã dự phòng hoặc tắt bảo mật 2 lớp
              </label>
              <input
                id="mfa-current-password"
                type="password"
                className="form-input max-w-md"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Mật khẩu đăng nhập hiện tại"
              />
            </div>

            <div className="flex flex-wrap gap-2.5">
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => void handleRegenerateCodes()}
                disabled={isBusy}
              >
                <KeyRound className="h-4 w-4" aria-hidden="true" />
                Tạo bộ mã dự phòng mới
              </button>

              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void handleDisableMfa()}
                disabled={isBusy}
              >
                Tắt bảo mật 2 lớp
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
