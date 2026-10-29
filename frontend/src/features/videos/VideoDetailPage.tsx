import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiRequestError } from '../../app/apiClient';
import {
  formatByteSize,
  formatDurationSeconds,
  formatHoChiMinhDateTime,
  getCaptureStatusBadge,
  getDeletionStatusBadge,
  getPreviewStatusLabel,
  getSourceBadge,
  getStorageStatusBadge
} from '../../app/formatters';
import {
  addVideoNoteApi,
  approveDeletionRequestApi,
  buildVideoDownloadUrl,
  buildVideoStreamUrl,
  createDeletionRequestApi,
  getVideoDetailApi,
  rejectDeletionRequestApi,
  updateVideoHoldApi,
  type StreamVariantChoice,
  type VideoDetailDto
} from './videosApi';

export function VideoDetailPage() {
  const { id } = useParams<{ id: string }>();

  const [detail, setDetail] = useState<VideoDetailDto | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [softDeletedDoneMessage, setSoftDeletedDoneMessage] = useState<string | null>(
    null
  );

  // Playback state
  const [streamVariant, setStreamVariant] = useState<StreamVariantChoice>('auto');
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  // Notes form state
  const [noteInput, setNoteInput] = useState<string>('');
  const [isSubmittingNote, setIsSubmittingNote] = useState<boolean>(false);
  const [noteError, setNoteError] = useState<string | null>(null);

  // Hold modal state
  const [isHoldModalOpen, setIsHoldModalOpen] = useState<boolean>(false);
  const [holdReasonInput, setHoldReasonInput] = useState<string>('');
  const [isUpdatingHold, setIsUpdatingHold] = useState<boolean>(false);
  const [holdError, setHoldError] = useState<string | null>(null);

  // Deletion request modal state
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState<boolean>(false);
  const [deleteReasonInput, setDeleteReasonInput] = useState<string>('');
  const [isSubmittingDeleteReq, setIsSubmittingDeleteReq] = useState<boolean>(false);
  const [deleteReqError, setDeleteReqError] = useState<string | null>(null);

  // Deletion review state
  const [reviewNoteInput, setReviewNoteInput] = useState<string>('');
  const [isReviewingDelete, setIsReviewingDelete] = useState<boolean>(false);
  const [reviewDeleteError, setReviewDeleteError] = useState<string | null>(null);

  const loadDetail = useCallback(async () => {
    if (!id) {
      return;
    }
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await getVideoDetailApi(id);
      setDetail(res);
    } catch (err) {
      setLoadError(
        err instanceof Error
          ? err.message
          : 'Không thể tải thông tin chi tiết video.'
      );
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const canPlayVideo =
    detail != null &&
    detail.storageStatus === 'Stored' &&
    (detail.hasOriginalAsset || detail.hasPreviewAsset);

  const streamUrl = useMemo(() => {
    if (!detail) {
      return '';
    }
    return buildVideoStreamUrl(detail.id, streamVariant);
  }, [detail, streamVariant]);

  const handleVideoElementError = useCallback(async () => {
    if (!streamUrl) {
      return;
    }

    try {
      const probe = await fetch(streamUrl, {
        method: 'HEAD',
        credentials: 'include'
      });

      if (probe.status === 503) {
        setPlaybackError(
          'Tệp video trên kho lưu trữ (Synology NAS / ổ đĩa) hiện tạm thời không thể truy cập (HTTP 503). Hệ thống không tự ý phát từ vùng đệm chưa xác thực — vui lòng kiểm tra lại kết nối lưu trữ.'
        );
        return;
      }

      if (probe.status === 401 || probe.status === 403) {
        setPlaybackError(
          'Phiên đăng nhập đã hết hạn hoặc bạn không còn quyền xem video này.'
        );
        return;
      }
    } catch {
      // Fall through to generic playback error
    }

    if (detail?.hasPreviewAsset && streamVariant === 'original') {
      setPlaybackError(
        'Trình duyệt hiện tại không giải mã trực tiếp được codec gốc. Hãy chuyển sang chế độ "Bản xem MP4 tương thích".'
      );
      return;
    }

    setPlaybackError(
      'Không thể phát luồng video ngay lúc này. Vui lòng kiểm tra kết nối mạng hoặc kho lưu trữ.'
    );
  }, [detail?.hasPreviewAsset, streamUrl, streamVariant]);

  const handleAddNoteSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!detail || !detail.canNote) {
      return;
    }

    const trimmed = noteInput.trim();
    if (!trimmed) {
      setNoteError('Vui lòng nhập nội dung ghi chú.');
      return;
    }

    setIsSubmittingNote(true);
    setNoteError(null);
    try {
      const created = await addVideoNoteApi(detail.id, trimmed);
      setDetail((prev) =>
        prev ? { ...prev, notes: [created, ...prev.notes] } : prev
      );
      setNoteInput('');
    } catch (err) {
      setNoteError(
        err instanceof Error ? err.message : 'Không thể lưu ghi chú mới.'
      );
    } finally {
      setIsSubmittingNote(false);
    }
  };

  const handleEnableHoldSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!detail || !detail.canHold) {
      return;
    }

    const trimmed = holdReasonInput.trim();
    if (trimmed.length < 3) {
      setHoldError(
        'Vui lòng nhập lý do giữ bằng chứng (Hold) tối thiểu 3 ký tự.'
      );
      return;
    }

    setIsUpdatingHold(true);
    setHoldError(null);
    try {
      const updated = await updateVideoHoldApi(detail.id, true, trimmed);
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              hold: updated.hold,
              holdReason: updated.holdReason,
              holdUpdatedByUserId: updated.holdUpdatedByUserId,
              holdUpdatedAtUtc: updated.holdUpdatedAtUtc
            }
          : prev
      );
      setIsHoldModalOpen(false);
      setHoldReasonInput('');
    } catch (err) {
      setHoldError(
        err instanceof Error
          ? err.message
          : 'Không thể bật chế độ giữ bằng chứng (Hold).'
      );
    } finally {
      setIsUpdatingHold(false);
    }
  };

  const handleReleaseHold = async () => {
    if (!detail || !detail.canHold) {
      return;
    }

    setIsUpdatingHold(true);
    setHoldError(null);
    try {
      const updated = await updateVideoHoldApi(detail.id, false, null);
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              hold: updated.hold,
              holdReason: updated.holdReason,
              holdUpdatedByUserId: updated.holdUpdatedByUserId,
              holdUpdatedAtUtc: updated.holdUpdatedAtUtc
            }
          : prev
      );
    } catch (err) {
      setHoldError(
        err instanceof Error
          ? err.message
          : 'Không thể gỡ chế độ giữ bằng chứng (Hold).'
      );
    } finally {
      setIsUpdatingHold(false);
    }
  };

  const handleCreateDeletionRequestSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!detail || !detail.canRequestDelete || detail.hold) {
      return;
    }

    const trimmed = deleteReasonInput.trim();
    if (trimmed.length < 3) {
      setDeleteReqError('Vui lòng nhập lý do yêu cầu xóa tối thiểu 3 ký tự.');
      return;
    }

    setIsSubmittingDeleteReq(true);
    setDeleteReqError(null);
    try {
      const created = await createDeletionRequestApi(detail.id, trimmed);
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              deletionRequests: [created, ...prev.deletionRequests]
            }
          : prev
      );
      setIsDeleteModalOpen(false);
      setDeleteReasonInput('');
    } catch (err) {
      setDeleteReqError(
        err instanceof ApiRequestError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Không thể gửi yêu cầu xóa video.'
      );
    } finally {
      setIsSubmittingDeleteReq(false);
    }
  };

  const pendingDeletionRequest = useMemo(
    () => detail?.deletionRequests.find((d) => d.status === 'Pending') ?? null,
    [detail?.deletionRequests]
  );

  const handleApproveDeletion = async () => {
    if (!detail || !pendingDeletionRequest || !detail.canApproveDelete || detail.hold) {
      return;
    }

    setIsReviewingDelete(true);
    setReviewDeleteError(null);
    try {
      await approveDeletionRequestApi(
        pendingDeletionRequest.id,
        reviewNoteInput.trim() || null
      );
      setSoftDeletedDoneMessage(
        `Đã phê duyệt ẩn mềm (soft-delete) video mã vận đơn ${detail.trackingNumber}. Bản ghi đã được ẩn khỏi danh sách tra cứu và lưu vào nhật ký kiểm toán.`
      );
    } catch (err) {
      setReviewDeleteError(
        err instanceof Error
          ? err.message
          : 'Không thể phê duyệt xóa video.'
      );
    } finally {
      setIsReviewingDelete(false);
    }
  };

  const handleRejectDeletion = async () => {
    if (!detail || !pendingDeletionRequest || !detail.canApproveDelete) {
      return;
    }

    setIsReviewingDelete(true);
    setReviewDeleteError(null);
    try {
      const updated = await rejectDeletionRequestApi(
        pendingDeletionRequest.id,
        reviewNoteInput.trim() || null
      );
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              deletionRequests: prev.deletionRequests.map((item) =>
                item.id === updated.id ? updated : item
              )
            }
          : prev
      );
      setReviewNoteInput('');
    } catch (err) {
      setReviewDeleteError(
        err instanceof Error
          ? err.message
          : 'Không thể từ chối yêu cầu xóa video.'
      );
    } finally {
      setIsReviewingDelete(false);
    }
  };

  if (isLoading) {
    return (
      <div className="surface-card" role="status">
        Đang tải chi tiết video bằng chứng...
      </div>
    );
  }

  if (softDeletedDoneMessage) {
    return (
      <div className="surface-card">
        <div className="alert alert-success" role="status">
          {softDeletedDoneMessage}
        </div>
        <Link to="/videos" className="btn btn-primary">
          Quay về thư viện video
        </Link>
      </div>
    );
  }

  if (loadError || !detail) {
    return (
      <div className="surface-card" role="alert">
        <h1 className="page-title">Không thể mở video bằng chứng</h1>
        <p style={{ color: 'var(--color-danger)' }}>
          {loadError ?? 'Bản ghi không tồn tại hoặc nằm ngoài phạm vi quyền của bạn.'}
        </p>
        <Link to="/videos" className="btn btn-outline">
          Quay về danh sách video
        </Link>
      </div>
    );
  }

  const captureBadge = getCaptureStatusBadge(detail.captureStatus);
  const storageBadge = getStorageStatusBadge(
    detail.storageStatus,
    detail.storageMode
  );
  const sourceBadge = getSourceBadge(detail.source);

  return (
    <div>
      {/* Top Header & Navigation */}
      <div className="surface-card">
        <div className="page-header-row">
          <div>
            <div style={{ marginBottom: 6 }}>
              <Link
                to="/videos"
                style={{
                  color: 'var(--color-cyan)',
                  fontWeight: 600,
                  textDecoration: 'none',
                  fontSize: '0.9rem'
                }}
              >
                ← Quay lại thư viện video
              </Link>
            </div>
            <h1 className="page-title">
              Mã vận đơn:{' '}
              <span className="mono-code" data-testid="detail-tracking-number">
                {detail.trackingNumber}
              </span>
            </h1>
            <p className="page-subtitle">
              {detail.shopName} ({detail.shopCode}) • {detail.warehouseName} (
              {detail.warehouseCode}) • Người thực hiện:{' '}
              <strong>{detail.ownerFullName}</strong> ({detail.ownerEmail})
            </p>
          </div>

          <div className="badge-cluster">
            <span
              className={captureBadge.className}
              data-testid="detail-capture-badge"
            >
              {captureBadge.label}
            </span>
            <span
              className={storageBadge.className}
              data-testid="detail-storage-badge"
            >
              {storageBadge.label}
            </span>
            <span
              className={sourceBadge.className}
              data-testid="detail-source-badge"
            >
              {sourceBadge.label}
            </span>
            {detail.hold && (
              <span className="status-pill status-pill-hold">
                Đang giữ chống xóa (Hold)
              </span>
            )}
          </div>
        </div>

        {/* Prominent Interrupted Warning Banner */}
        {detail.captureStatus === 'Interrupted' && (
          <div
            className="alert alert-error"
            role="alert"
            data-testid="detail-interrupted-banner"
            style={{ marginTop: 14, marginBottom: 0 }}
          >
            <strong>Cảnh báo: Phiên ghi hình bị gián đoạn!</strong> Video này dừng bất
            thường trước khi nhân viên kết thúc phiên đóng gói chuẩn. Không được coi là
            bằng chứng đóng gói hoàn chỉnh nếu chưa kiểm tra kỹ toàn bộ khung hình hoặc
            quay lại kiện hàng.
            {detail.userSafeErrorMessage ? (
              <div style={{ marginTop: 4 }}>
                Chi tiết sự cố: <strong>{detail.userSafeErrorMessage}</strong>
              </div>
            ) : null}
          </div>
        )}

        {/* Active Hold Protection Banner */}
        {detail.hold && (
          <div
            className="alert alert-warning"
            role="status"
            data-testid="detail-hold-banner"
            style={{ marginTop: 14, marginBottom: 0 }}
          >
            <strong>Đang bật Giữ bằng chứng tranh chấp (Hold):</strong>{' '}
            {detail.holdReason ?? 'Bảo vệ bằng chứng đơn hàng.'}
            <div style={{ fontSize: '0.84rem', marginTop: 4 }}>
              Khi Hold đang bật, mọi yêu cầu xóa thủ công, phê duyệt xóa và tác vụ dọn dẹp
              tự động theo thời hạn (Retention) đều bị chặn.
              {detail.holdUpdatedAtUtc
                ? ` Cập nhật lúc: ${formatHoChiMinhDateTime(detail.holdUpdatedAtUtc)}.`
                : ''}
            </div>
          </div>
        )}

        {/* Permission-Gated Action Buttons (Zero Fake/Dead Buttons!) */}
        <div className="quick-actions-row">
          {detail.canDownload &&
            detail.storageStatus === 'Stored' &&
            detail.hasOriginalAsset && (
              <a
                href={buildVideoDownloadUrl(detail.id)}
                download
                className="btn btn-primary"
                data-testid="download-original-btn"
              >
                Tải tệp video gốc
              </a>
            )}

          {detail.canReRecordWithCorrectCode && (
            <Link
              to={`/record?linkedFrom=${encodeURIComponent(
                detail.id
              )}&reason=${encodeURIComponent(
                `Quay lại bằng mã đúng thay cho ${detail.trackingNumber}`
              )}`}
              className="btn btn-outline"
              data-testid="rerecord-correct-code-link"
            >
              Quay lại bằng mã vận đơn đúng
            </Link>
          )}

          {detail.canHold && !detail.hold && (
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => {
                setHoldError(null);
                setIsHoldModalOpen(true);
              }}
              disabled={isUpdatingHold}
            >
              Giữ bằng chứng (Bật Hold)
            </button>
          )}

          {detail.canHold && detail.hold && (
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => void handleReleaseHold()}
              disabled={isUpdatingHold}
            >
              {isUpdatingHold ? 'Đang gỡ Hold...' : 'Gỡ chế độ Giữ (Hold)'}
            </button>
          )}

          {detail.canRequestDelete && !pendingDeletionRequest && (
            <button
              type="button"
              className="btn btn-danger"
              data-testid="request-delete-btn"
              disabled={detail.hold}
              onClick={() => {
                setDeleteReqError(null);
                setIsDeleteModalOpen(true);
              }}
            >
              Yêu cầu xóa video
            </button>
          )}
        </div>

        {detail.canRequestDelete && detail.hold && (
          <div
            style={{
              marginTop: 10,
              fontSize: '0.86rem',
              color: 'var(--color-warning-text)',
              fontWeight: 600
            }}
            data-testid="delete-blocked-by-hold-notice"
          >
            Không thể gửi yêu cầu xóa khi video đang ở chế độ Giữ bằng chứng (Hold). Cần
            gỡ Hold trước khi yêu cầu xóa.
          </div>
        )}

        {holdError && (
          <div className="alert alert-error" role="alert" style={{ marginTop: 12 }}>
            {holdError}
          </div>
        )}
      </div>

      {/* Main Content Grid: Player + Metadata & Governance */}
      <div className="detail-layout-grid">
        {/* Left Column: HTTP Range Player & Notes */}
        <div>
          <div className="surface-card">
            <div className="page-header-row" style={{ marginBottom: 12 }}>
              <h2 style={{ margin: 0, fontSize: '1.08rem' }}>
                Trình phát video bằng chứng
              </h2>

              {canPlayVideo && detail.hasPreviewAsset && (
                <div className="segmented-tabs" aria-label="Chọn phiên bản phát">
                  <button
                    type="button"
                    className={`segmented-tab${
                      streamVariant === 'auto' ? ' active' : ''
                    }`}
                    onClick={() => {
                      setPlaybackError(null);
                      setStreamVariant('auto');
                    }}
                  >
                    Tự động
                  </button>
                  <button
                    type="button"
                    className={`segmented-tab${
                      streamVariant === 'preview' ? ' active' : ''
                    }`}
                    onClick={() => {
                      setPlaybackError(null);
                      setStreamVariant('preview');
                    }}
                  >
                    Bản xem MP4
                  </button>
                  <button
                    type="button"
                    className={`segmented-tab${
                      streamVariant === 'original' ? ' active' : ''
                    }`}
                    onClick={() => {
                      setPlaybackError(null);
                      setStreamVariant('original');
                    }}
                  >
                    Tệp gốc
                  </button>
                </div>
              )}
            </div>

            {canPlayVideo ? (
              <>
                <div className="video-player-frame">
                  <video
                    key={streamUrl}
                    className="video-player-element"
                    src={streamUrl}
                    controls
                    playsInline
                    preload="metadata"
                    controlsList={detail.canDownload ? undefined : 'nodownload'}
                    onError={() => void handleVideoElementError()}
                    data-testid="authenticated-video-player"
                  />
                </div>
                <p
                  style={{
                    margin: '8px 0 0',
                    fontSize: '0.82rem',
                    color: 'var(--color-text-muted)'
                  }}
                >
                  Phát qua luồng xác thực nội bộ hỗ trợ tua nhanh (HTTP Range 206).{' '}
                  {getPreviewStatusLabel(detail.previewStatus)}.
                </p>
              </>
            ) : (
              <div className="alert alert-info" role="status" style={{ marginBottom: 0 }}>
                <strong>Video chưa sẵn sàng để phát trực tuyến:</strong> Trạng thái lưu
                trữ hiện tại là <strong>{storageBadge.label}</strong>.
                {detail.userSafeErrorMessage ? (
                  <div style={{ marginTop: 6 }}>
                    Thông báo hệ thống: {detail.userSafeErrorMessage}
                  </div>
                ) : null}
              </div>
            )}

            {playbackError && (
              <div
                className="alert alert-error"
                role="alert"
                data-testid="video-playback-error"
                style={{ marginTop: 12, marginBottom: 0 }}
              >
                {playbackError}
              </div>
            )}
          </div>

          {/* Notes Section */}
          <div className="surface-card">
            <h2 style={{ marginTop: 0, fontSize: '1.08rem' }}>
              Ghi chú đối chiếu &amp; khiếu nại ({detail.notes.length})
            </h2>

            {detail.canNote && (
              <form onSubmit={(e) => void handleAddNoteSubmit(e)}>
                <div className="form-group" style={{ marginBottom: 10 }}>
                  <label htmlFor="video-note-input" className="form-label">
                    Thêm ghi chú nội bộ mới
                  </label>
                  <textarea
                    id="video-note-input"
                    className="form-input"
                    rows={3}
                    maxLength={2000}
                    value={noteInput}
                    onChange={(e) => setNoteInput(e.target.value)}
                    placeholder="Ghi nhận tình trạng kiện hàng, mã khiếu nại TikTok Shop hoặc kết quả đối chiếu..."
                  />
                </div>

                {noteError && (
                  <div className="alert alert-error" role="alert">
                    {noteError}
                  </div>
                )}

                <button
                  type="submit"
                  className="btn btn-navy"
                  disabled={isSubmittingNote}
                >
                  {isSubmittingNote ? 'Đang lưu ghi chú...' : 'Lưu ghi chú'}
                </button>
              </form>
            )}

            {detail.notes.length === 0 ? (
              <p
                style={{
                  color: 'var(--color-text-muted)',
                  marginTop: detail.canNote ? 14 : 0,
                  marginBottom: 0
                }}
              >
                Chưa có ghi chú nào cho video này.
              </p>
            ) : (
              <div className="note-list">
                {detail.notes.map((n) => (
                  <div key={n.id} className="note-item">
                    <div className="note-header">
                      <strong>
                        {n.authorFullName} ({n.authorEmail})
                      </strong>
                      <span>{formatHoChiMinhDateTime(n.createdAtUtc)}</span>
                    </div>
                    <div style={{ whiteSpace: 'pre-wrap', fontSize: '0.92rem' }}>
                      {n.content}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Technical Metadata & Deletion Workflow */}
        <div>
          <div className="surface-card">
            <h2 style={{ marginTop: 0, fontSize: '1.08rem' }}>
              Thông tin định danh &amp; kiểm định kỹ thuật
            </h2>
            <p
              style={{
                marginTop: 0,
                fontSize: '0.83rem',
                color: 'var(--color-text-muted)'
              }}
            >
              Mã vận đơn của bản ghi đã lưu là <strong>bất biến</strong> để bảo vệ tính
              toàn vẹn bằng chứng.
            </p>

            <div className="kv-dl">
              <div className="kv-item">
                <div className="kv-term">Mã vận đơn (Bất biến)</div>
                <div className="kv-desc mono-code">{detail.trackingNumber}</div>
              </div>

              <div className="kv-item">
                <div className="kv-term">Đơn vị vận chuyển</div>
                <div className="kv-desc">{detail.carrierCode ?? 'Chưa phân loại'}</div>
              </div>

              {detail.tikTokOrderId && (
                <div className="kv-item kv-item-full">
                  <div className="kv-term">Mã đơn TikTok (Tách biệt mã vận đơn)</div>
                  <div className="kv-desc mono-code">{detail.tikTokOrderId}</div>
                </div>
              )}

              <div className="kv-item">
                <div className="kv-term">Nguồn tạo video</div>
                <div className="kv-desc">{sourceBadge.label}</div>
              </div>

              <div className="kv-item">
                <div className="kv-term">Nơi lưu trữ xác nhận</div>
                <div className="kv-desc">{storageBadge.label}</div>
              </div>

              <div className="kv-item">
                <div className="kv-term">Thời lượng thực tế</div>
                <div className="kv-desc">
                  {formatDurationSeconds(detail.durationSeconds)}
                </div>
              </div>

              <div className="kv-item">
                <div className="kv-term">Dung lượng tệp gốc</div>
                <div className="kv-desc">
                  {formatByteSize(detail.originalSizeBytes)}
                </div>
              </div>

              <div className="kv-item">
                <div className="kv-term">Độ phân giải</div>
                <div className="kv-desc">
                  {detail.width && detail.height
                    ? `${detail.width} × ${detail.height}`
                    : '—'}
                </div>
              </div>

              <div className="kv-item">
                <div className="kv-term">Định dạng &amp; Codec</div>
                <div className="kv-desc">
                  {detail.actualMimeType ?? '—'}
                  {detail.videoCodec ? ` (${detail.videoCodec}` : ''}
                  {detail.videoCodec && detail.audioCodec
                    ? ` / ${detail.audioCodec})`
                    : detail.videoCodec
                      ? ')'
                      : ''}
                </div>
              </div>

              <div className="kv-item">
                <div className="kv-term">Bắt đầu quay (GMT+7)</div>
                <div className="kv-desc">
                  {formatHoChiMinhDateTime(detail.startedAtUtc ?? detail.createdAtUtc)}
                </div>
              </div>

              <div className="kv-item">
                <div className="kv-term">Lưu hoàn tất (GMT+7)</div>
                <div className="kv-desc">
                  {formatHoChiMinhDateTime(detail.storedAtUtc)}
                </div>
              </div>

              {detail.isManualCode && (
                <div className="kv-item kv-item-full">
                  <div className="kv-term">Nhập mã vận đơn thủ công</div>
                  <div className="kv-desc">
                    Lý do: {detail.manualEntryReason ?? 'Đã ghi nhật ký kiểm toán'}
                  </div>
                </div>
              )}

              {detail.linkedFromRecordingId && (
                <div className="kv-item kv-item-full">
                  <div className="kv-term">Liên kết từ phiên nhầm mã trước đó</div>
                  <div className="kv-desc">
                    <Link
                      to={`/videos/${detail.linkedFromRecordingId}`}
                      style={{ color: 'var(--color-cyan)' }}
                    >
                      Xem phiên gốc ({detail.linkedFromTrackingNumber ?? detail.linkedFromRecordingId})
                    </Link>
                  </div>
                </div>
              )}

              <div className="kv-item kv-item-full">
                <div className="kv-term">Mã băm toàn vẹn SHA-256 (Tệp gốc)</div>
                <div
                  className="kv-desc mono-code"
                  style={{ fontSize: '0.82rem' }}
                  data-testid="detail-sha256"
                >
                  {detail.originalSha256 ?? 'Chưa tính toán'}
                </div>
              </div>
            </div>
          </div>

          {/* Deletion Requests & Approval Section */}
          {(detail.deletionRequests.length > 0 || detail.canApproveDelete) && (
            <div className="surface-card">
              <h2 style={{ marginTop: 0, fontSize: '1.08rem' }}>
                Lịch sử &amp; Phê duyệt yêu cầu xóa
              </h2>

              {pendingDeletionRequest && detail.canApproveDelete && (
                <div
                  className="mobile-data-card"
                  style={{
                    marginBottom: 14,
                    background: '#FFFBEB',
                    borderColor: '#F59E0B'
                  }}
                >
                  <div>
                    <strong>Yêu cầu xóa đang chờ phê duyệt:</strong> từ{' '}
                    {pendingDeletionRequest.requestedByFullName} (
                    {pendingDeletionRequest.requestedByEmail})
                  </div>
                  <div style={{ fontSize: '0.9rem' }}>
                    Lý do: <strong>{pendingDeletionRequest.reason}</strong>
                  </div>

                  {detail.hold && (
                    <div className="alert alert-warning" style={{ marginBottom: 0 }}>
                      Video đang ở trạng thái <strong>Giữ bằng chứng (Hold)</strong>. Không
                      thể phê duyệt xóa khi Hold đang bật.
                    </div>
                  )}

                  <div className="form-group" style={{ marginBottom: 6 }}>
                    <label htmlFor="review-delete-note" className="form-label">
                      Ghi chú phê duyệt / từ chối (tùy chọn)
                    </label>
                    <input
                      id="review-delete-note"
                      type="text"
                      className="form-input"
                      maxLength={500}
                      value={reviewNoteInput}
                      onChange={(e) => setReviewNoteInput(e.target.value)}
                      placeholder="Nhập nhận xét của người duyệt..."
                    />
                  </div>

                  {reviewDeleteError && (
                    <div className="alert alert-error" role="alert">
                      {reviewDeleteError}
                    </div>
                  )}

                  <div className="quick-actions-row" style={{ marginTop: 4 }}>
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={detail.hold || isReviewingDelete}
                      onClick={() => void handleApproveDeletion()}
                    >
                      Phê duyệt xóa mềm
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline"
                      disabled={isReviewingDelete}
                      onClick={() => void handleRejectDeletion()}
                    >
                      Từ chối yêu cầu
                    </button>
                  </div>
                </div>
              )}

              {detail.deletionRequests.length === 0 ? (
                <p style={{ color: 'var(--color-text-muted)', marginBottom: 0 }}>
                  Chưa có yêu cầu xóa nào đối với video này.
                </p>
              ) : (
                <div className="note-list">
                  {detail.deletionRequests.map((dr) => {
                    const badge = getDeletionStatusBadge(dr.status);
                    return (
                      <div key={dr.id} className="note-item">
                        <div className="note-header">
                          <strong>{dr.requestedByFullName}</strong>
                          <span className={badge.className}>{badge.label}</span>
                        </div>
                        <div style={{ fontSize: '0.9rem', marginBottom: 4 }}>
                          Lý do: {dr.reason}
                        </div>
                        <div
                          style={{
                            fontSize: '0.8rem',
                            color: 'var(--color-text-muted)'
                          }}
                        >
                          Yêu cầu lúc: {formatHoChiMinhDateTime(dr.createdAtUtc)}
                          {dr.reviewedAtUtc
                            ? ` • Xử lý lúc: ${formatHoChiMinhDateTime(dr.reviewedAtUtc)} bởi ${dr.reviewedByFullName ?? ''}`
                            : ''}
                        </div>
                        {dr.reviewNote && (
                          <div style={{ fontSize: '0.84rem', marginTop: 4 }}>
                            Phản hồi người duyệt: <em>{dr.reviewNote}</em>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Hold Modal */}
      {isHoldModalOpen && detail.canHold && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="hold-modal-title"
          >
            <h2 id="hold-modal-title" style={{ marginTop: 0, fontSize: '1.15rem' }}>
              Bật Giữ bằng chứng tranh chấp (Hold)
            </h2>
            <p style={{ fontSize: '0.88rem', color: 'var(--color-text-muted)' }}>
              Video đang bật Hold sẽ được bảo vệ khỏi mọi thao tác yêu cầu xóa, phê duyệt
              xóa và dọn dẹp tự động theo thời hạn lưu giữ.
            </p>
            <form onSubmit={(e) => void handleEnableHoldSubmit(e)}>
              <div className="form-group">
                <label htmlFor="hold-reason-textarea" className="form-label">
                  Lý do giữ bằng chứng (bắt buộc)
                </label>
                <textarea
                  id="hold-reason-textarea"
                  className="form-input"
                  rows={3}
                  maxLength={500}
                  value={holdReasonInput}
                  onChange={(e) => setHoldReasonInput(e.target.value)}
                  placeholder="Ví dụ: Khách khiếu nại thiếu phụ kiện trên TikTok Shop — giữ đối chiếu"
                  required
                />
              </div>

              {holdError && (
                <div className="alert alert-error" role="alert">
                  {holdError}
                </div>
              )}

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => setIsHoldModalOpen(false)}
                  disabled={isUpdatingHold}
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={isUpdatingHold}
                >
                  {isUpdatingHold ? 'Đang lưu...' : 'Xác nhận bật Hold'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Request Soft-Delete Modal */}
      {isDeleteModalOpen && detail.canRequestDelete && !detail.hold && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-request-modal-title"
          >
            <h2
              id="delete-request-modal-title"
              style={{ marginTop: 0, fontSize: '1.15rem' }}
            >
              Gửi yêu cầu xóa video
            </h2>
            <p style={{ fontSize: '0.88rem', color: 'var(--color-text-muted)' }}>
              Yêu cầu này sẽ được chuyển tới quản trị viên có quyền phê duyệt xóa trong
              phạm vi Shop/Kho và ghi nhận vào nhật ký kiểm toán.
            </p>
            <form onSubmit={(e) => void handleCreateDeletionRequestSubmit(e)}>
              <div className="form-group">
                <label htmlFor="delete-reason-textarea" className="form-label">
                  Lý do yêu cầu xóa (bắt buộc)
                </label>
                <textarea
                  id="delete-reason-textarea"
                  className="form-input"
                  rows={3}
                  maxLength={500}
                  value={deleteReasonInput}
                  onChange={(e) => setDeleteReasonInput(e.target.value)}
                  placeholder="Ví dụ: Bản ghi quay thử bàn đóng gói không chứa kiện hàng thật"
                  required
                />
              </div>

              {deleteReqError && (
                <div className="alert alert-error" role="alert">
                  {deleteReqError}
                </div>
              )}

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => setIsDeleteModalOpen(false)}
                  disabled={isSubmittingDeleteReq}
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  className="btn btn-danger"
                  disabled={isSubmittingDeleteReq}
                >
                  {isSubmittingDeleteReq ? 'Đang gửi...' : 'Gửi yêu cầu xóa'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
