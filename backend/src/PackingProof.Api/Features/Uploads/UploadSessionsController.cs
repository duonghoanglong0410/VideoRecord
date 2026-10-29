using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using PackingProof.Api.Common;
using PackingProof.Api.Features.Recordings;
using PackingProof.Core.Abstractions;
using PackingProof.Core.Entities;
using PackingProof.Core.Enums;
using PackingProof.Core.Permissions;
using PackingProof.Core.Tracking;
using PackingProof.Infrastructure.Configuration;
using PackingProof.Infrastructure.Persistence;
using PackingProof.Infrastructure.Uploads;
using PackingProof.Infrastructure.Workers;
using tusdotnet.Stores;

namespace PackingProof.Api.Features.Uploads;

[ApiController]
[Route("api/recordings")]
[Authorize]
public sealed class UploadSessionsController : ControllerBase
{
    private static readonly TimeSpan DefaultSessionLifetime = TimeSpan.FromHours(24);

    private readonly PackingProofDbContext _db;
    private readonly IScopeAuthorizationService _scopeAuth;
    private readonly IAuditLogger _auditLogger;
    private readonly StagingQuotaGuard _stagingQuotaGuard;
    private readonly IProcessingJobSignal _jobSignal;
    private readonly PackingProofOptions _options;

    public UploadSessionsController(
        PackingProofDbContext db,
        IScopeAuthorizationService scopeAuth,
        IAuditLogger auditLogger,
        StagingQuotaGuard stagingQuotaGuard,
        IProcessingJobSignal jobSignal,
        PackingProofOptions options)
    {
        _db = db;
        _scopeAuth = scopeAuth;
        _auditLogger = auditLogger;
        _stagingQuotaGuard = stagingQuotaGuard;
        _jobSignal = jobSignal;
        _options = options;
    }

    [HttpPost("{id:guid}/upload-session")]
    public async Task<ActionResult<UploadSessionDto>> CreateOrGetUploadSession(
        Guid id,
        [FromBody] CreateUploadSessionRequest request,
        CancellationToken ct)
    {
        var userId = HttpContext.GetRequiredUserId();
        var userEmail = HttpContext.GetUserEmail();

        var recording = await _db.Recordings
            .AsNoTracking()
            .FirstOrDefaultAsync(r => r.Id == id && !r.IsSoftDeleted, ct);

        if (recording is null)
        {
            return NotFound(new ApiErrorResponse(
                "RECORDING_NOT_FOUND",
                "Không tìm thấy phiên quay yêu cầu."));
        }

        var scopeContext = new ResourceScopeContext(
            OwnerUserId: recording.OwnerUserId,
            ShopId: recording.ShopId,
            WarehouseId: recording.WarehouseId);

        var canUploadForRecording =
            await _scopeAuth.HasPermissionAsync(userId, PermissionCatalog.VideoUpload, scopeContext, ct) ||
            (recording.Source == RecordingSource.Imported &&
             await _scopeAuth.HasPermissionAsync(userId, PermissionCatalog.VideoImport, scopeContext, ct));

        var isAuthorizedOwner = recording.OwnerUserId == userId && canUploadForRecording;

        if (!isAuthorizedOwner)
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "video.upload_session",
                EntityType: "Recording",
                EntityId: recording.Id.ToString(),
                Outcome: AuditOutcome.Denied,
                ActorUserId: userId,
                ActorEmail: userEmail,
                ShopId: recording.ShopId,
                WarehouseId: recording.WarehouseId,
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new { reason = "NOT_OWNER_OR_MISSING_VIDEO_UPLOAD_SCOPE" }), ct);

            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "FORBIDDEN",
                "Chỉ người tạo phiên quay có quyền tải video lên trong phạm vi Shop/Kho này mới được khởi tạo phiên tải lên."));
        }

        if (recording.StorageStatus != StorageStatus.Stored &&
            recording.CaptureStatus is not (CaptureStatus.Captured or CaptureStatus.Interrupted))
        {
            return Conflict(new ApiErrorResponse(
                "INVALID_RECORDING_STATE_FOR_UPLOAD",
                "Phiên quay phải kết thúc ghi hình (Hoàn chỉnh hoặc Bị gián đoạn) trước khi khởi tạo phiên tải lên máy chủ."));
        }

        var maxUploadBytes = await GetMaxUploadBytesAsync(ct);
        if (request.ExpectedBytes <= 0)
        {
            return BadRequest(new ApiErrorResponse(
                "INVALID_EXPECTED_BYTES",
                "Dung lượng tệp dự kiến tải lên phải lớn hơn 0 byte."));
        }

        if (request.ExpectedBytes > maxUploadBytes)
        {
            return StatusCode(StatusCodes.Status413PayloadTooLarge, new ApiErrorResponse(
                "UPLOAD_SIZE_EXCEEDED",
                $"Dung lượng video ({request.ExpectedBytes:N0} byte) vượt quá giới hạn tối đa cho phép ({maxUploadBytes:N0} byte)."));
        }

        return await _stagingQuotaGuard.RunUnderReservationLockAsync<ActionResult<UploadSessionDto>>(async innerCt =>
        {
            var stagingRoot = Path.GetFullPath(_options.StagingRootPath);
            Directory.CreateDirectory(stagingRoot);
            var tusStore = new TusDiskStore(stagingRoot);
            var now = DateTime.UtcNow;

            var existingSession = await _db.UploadSessions
                .Include(u => u.Recording)
                .FirstOrDefaultAsync(u => u.RecordingId == id, innerCt);

            if (existingSession is not null)
            {
                var currentStorageStatus = existingSession.Recording.StorageStatus;
                if (currentStorageStatus == StorageStatus.Stored)
                {
                    return Ok(MapUploadSessionDto(existingSession, currentStorageStatus));
                }

                var hasAssignedTusId = !string.IsNullOrWhiteSpace(existingSession.TusResourceId) &&
                    !existingSession.TusResourceId.StartsWith(StagingQuotaGuard.PendingResourcePrefix, StringComparison.Ordinal);

                var tusFileExists = hasAssignedTusId &&
                    await tusStore.FileExistAsync(existingSession.TusResourceId, innerCt);

                if (tusFileExists)
                {
                    if (existingSession.ExpectedBytes != request.ExpectedBytes)
                    {
                        return Conflict(new ApiErrorResponse(
                            "UPLOAD_LENGTH_MISMATCH",
                            "Dung lượng tệp khai báo không khớp với phiên tải lên đang hoạt động của bản ghi này."));
                    }

                    var liveOffset = await tusStore.GetUploadOffsetAsync(existingSession.TusResourceId, innerCt);
                    existingSession.ReceivedBytes = liveOffset;
                    if (existingSession.ExpiresAtUtc <= now.AddHours(1))
                    {
                        existingSession.ExpiresAtUtc = now.Add(DefaultSessionLifetime);
                    }

                    await _db.SaveChangesAsync(innerCt);
                    return Ok(MapUploadSessionDto(existingSession, currentStorageStatus));
                }

                // Existing session has no tus file on disk yet (or previous staging file expired/aborted before Stored)
                var needsQuotaCheck = existingSession.ExpiresAtUtc <= now ||
                                      existingSession.Status is UploadSessionStatus.Aborted or UploadSessionStatus.Expired or UploadSessionStatus.Completed ||
                                      request.ExpectedBytes > existingSession.ExpectedBytes ||
                                      hasAssignedTusId;

                if (needsQuotaCheck)
                {
                    var (allowed, _) = await _stagingQuotaGuard.CanAccommodateAsync(
                        request.ExpectedBytes,
                        excludeRecordingId: id,
                        ct: innerCt);

                    if (!allowed)
                    {
                        return InsufficientStagingCapacity();
                    }
                }

                existingSession.TusResourceId = $"{StagingQuotaGuard.PendingResourcePrefix}{existingSession.Id:N}";
                existingSession.ExpectedBytes = request.ExpectedBytes;
                existingSession.ReceivedBytes = 0;
                existingSession.StagingFilePath = string.Empty;
                existingSession.ClientSha256 = NormalizeOptionalSha256(request.ClientSha256) ?? existingSession.ClientSha256;
                existingSession.Status = UploadSessionStatus.Initiated;
                existingSession.CompletedAtUtc = null;
                existingSession.ExpiresAtUtc = now.Add(DefaultSessionLifetime);

                await _db.SaveChangesAsync(innerCt);
                return Ok(MapUploadSessionDto(existingSession, currentStorageStatus));
            }

            var (quotaAllowed, _) = await _stagingQuotaGuard.CanAccommodateAsync(
                request.ExpectedBytes,
                excludeRecordingId: id,
                ct: innerCt);

            if (!quotaAllowed)
            {
                return InsufficientStagingCapacity();
            }

            var sessionId = Guid.NewGuid();
            var newSession = new UploadSession
            {
                Id = sessionId,
                RecordingId = recording.Id,
                OwnerUserId = userId,
                TusResourceId = $"{StagingQuotaGuard.PendingResourcePrefix}{sessionId:N}",
                ExpectedBytes = request.ExpectedBytes,
                ReceivedBytes = 0,
                ClientSha256 = NormalizeOptionalSha256(request.ClientSha256),
                Status = UploadSessionStatus.Initiated,
                StagingFilePath = string.Empty,
                ExpiresAtUtc = now.Add(DefaultSessionLifetime),
                CreatedAtUtc = now
            };

            _db.UploadSessions.Add(newSession);

            try
            {
                await _db.SaveChangesAsync(innerCt);
            }
            catch (DbUpdateException)
            {
                _db.ChangeTracker.Clear();
                var winner = await _db.UploadSessions
                    .AsNoTracking()
                    .Include(u => u.Recording)
                    .FirstAsync(u => u.RecordingId == id, innerCt);

                return Ok(MapUploadSessionDto(winner, winner.Recording.StorageStatus));
            }

            return Ok(MapUploadSessionDto(newSession, recording.StorageStatus));
        }, ct);
    }

    [HttpPost("{id:guid}/retry-storage")]
    public async Task<ActionResult<RecordingDto>> RetryStorage(Guid id, CancellationToken ct)
    {
        var userId = HttpContext.GetRequiredUserId();
        var userEmail = HttpContext.GetUserEmail();

        var recording = await _db.Recordings
            .Include(r => r.OwnerUser)
            .Include(r => r.Shop)
            .Include(r => r.Warehouse)
            .FirstOrDefaultAsync(r => r.Id == id && !r.IsSoftDeleted, ct);

        if (recording is null)
        {
            return NotFound(new ApiErrorResponse(
                "RECORDING_NOT_FOUND",
                "Không tìm thấy phiên quay yêu cầu."));
        }

        var scopeContext = new ResourceScopeContext(
            OwnerUserId: recording.OwnerUserId,
            ShopId: recording.ShopId,
            WarehouseId: recording.WarehouseId);

        var isOwnerWithUpload = recording.OwnerUserId == userId &&
            (await _scopeAuth.HasPermissionAsync(userId, PermissionCatalog.VideoUpload, scopeContext, ct) ||
             (recording.Source == RecordingSource.Imported &&
              await _scopeAuth.HasPermissionAsync(userId, PermissionCatalog.VideoImport, scopeContext, ct)));

        var isScopedManagerOrAdmin =
            await _scopeAuth.HasPermissionAsync(userId, PermissionCatalog.StorageManage, scopeContext, ct) ||
            await _scopeAuth.HasPermissionAsync(userId, PermissionCatalog.UserManage, scopeContext, ct) ||
            await _scopeAuth.HasPermissionAsync(userId, PermissionCatalog.VideoHold, scopeContext, ct);

        if (!isOwnerWithUpload && !isScopedManagerOrAdmin)
        {
            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "FORBIDDEN",
                "Bạn không có quyền kích hoạt thử lại lưu trữ cho bản ghi này."));
        }

        if (recording.StorageStatus == StorageStatus.Stored)
        {
            return Ok(RecordingsController.MapRecordingDto(
                recording,
                recording.OwnerUser.Email ?? string.Empty,
                recording.OwnerUser.FullName,
                recording.Shop.Name,
                recording.Warehouse.Name,
                _options.StorageMode));
        }

        if (!recording.IsRetryable &&
            recording.StorageStatus is not (StorageStatus.WaitingForStorage or StorageStatus.Validating))
        {
            return Conflict(new ApiErrorResponse(
                "STORAGE_NOT_RETRYABLE",
                "Bản ghi này không ở trạng thái lỗi tạm thời có thể thử lại lưu trữ."));
        }

        var uploadSession = await _db.UploadSessions
            .AsNoTracking()
            .FirstOrDefaultAsync(u => u.RecordingId == recording.Id, ct);

        var stagingRoot = Path.GetFullPath(_options.StagingRootPath);
        var stagingFilePath = ResolveStagingFile(stagingRoot, uploadSession);
        if (string.IsNullOrWhiteSpace(stagingFilePath) || !System.IO.File.Exists(stagingFilePath))
        {
            return Conflict(new ApiErrorResponse(
                "STAGING_FILE_MISSING",
                "Tệp dữ liệu tạm trên máy chủ không còn tồn tại. Vui lòng tải lại từ thiết bị nếu bản lưu cục bộ vẫn còn."));
        }

        var now = DateTime.UtcNow;
        var job = await _db.ProcessingJobs
            .FirstOrDefaultAsync(j =>
                j.RecordingId == recording.Id &&
                j.JobType == ProcessingJobType.ValidateAndStoreOriginal, ct);

        if (job is null)
        {
            job = new ProcessingJob
            {
                Id = Guid.NewGuid(),
                RecordingId = recording.Id,
                JobType = ProcessingJobType.ValidateAndStoreOriginal,
                Status = ProcessingJobStatus.Queued,
                AttemptCount = 0,
                MaxAttempts = Math.Max(1, _options.WorkerMaxAttempts),
                NextAttemptAtUtc = now,
                CreatedAtUtc = now
            };
            _db.ProcessingJobs.Add(job);
        }
        else
        {
            var hasActiveLease = job.Status == ProcessingJobStatus.Running &&
                                 job.LeaseExpiresAtUtc.HasValue &&
                                 job.LeaseExpiresAtUtc.Value > now;

            if (!hasActiveLease)
            {
                job.Status = ProcessingJobStatus.Queued;
                job.AttemptCount = 0;
                job.MaxAttempts = Math.Max(1, _options.WorkerMaxAttempts);
                job.NextAttemptAtUtc = now;
                job.LeaseOwner = null;
                job.LeaseExpiresAtUtc = null;
            }
        }

        recording.StorageStatus = StorageStatus.Validating;
        recording.UpdatedAtUtc = now;

        await _db.SaveChangesAsync(ct);

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "video.retry_storage",
            EntityType: "Recording",
            EntityId: recording.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: userId,
            ActorEmail: userEmail,
            ShopId: recording.ShopId,
            WarehouseId: recording.WarehouseId,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new { trackingNumber = recording.TrackingNumber }), ct);

        _jobSignal.NotifyNewWork();

        return Ok(RecordingsController.MapRecordingDto(
            recording,
            recording.OwnerUser.Email ?? string.Empty,
            recording.OwnerUser.FullName,
            recording.Shop.Name,
            recording.Warehouse.Name,
            _options.StorageMode));
    }

    private ObjectResult InsufficientStagingCapacity() =>
        StatusCode(StatusCodes.Status507InsufficientStorage, new ApiErrorResponse(
            "STAGING_CAPACITY_EXCEEDED",
            "Vùng lưu đệm tải lên trên máy chủ hiện đã đầy. Vui lòng chờ hệ thống xử lý bớt hàng đợi lưu trữ vào NAS rồi thử lại."));

    private UploadSessionDto MapUploadSessionDto(UploadSession session, StorageStatus recordingStorageStatus)
    {
        var isPending = string.IsNullOrWhiteSpace(session.TusResourceId) ||
            session.TusResourceId.StartsWith(StagingQuotaGuard.PendingResourcePrefix, StringComparison.Ordinal);

        var tusId = isPending ? null : session.TusResourceId;
        var tusUrl = isPending ? null : $"/api/uploads/{session.TusResourceId}";

        return new UploadSessionDto(
            UploadSessionId: session.Id,
            RecordingId: session.RecordingId,
            TusResourceId: tusId,
            TusUploadUrl: tusUrl,
            ExpectedBytes: session.ExpectedBytes,
            ReceivedBytes: session.ReceivedBytes,
            RecommendedChunkBytes: _options.UploadChunkBytes,
            SessionStatus: session.Status,
            RecordingStorageStatus: recordingStorageStatus,
            ExpiresAtUtc: session.ExpiresAtUtc);
    }

    private async Task<long> GetMaxUploadBytesAsync(CancellationToken ct)
    {
        var profile = await _db.StorageProfiles
            .AsNoTracking()
            .OrderBy(p => p.Name)
            .FirstOrDefaultAsync(ct);

        return profile?.MaxUploadBytes ?? _options.MaxUploadBytes;
    }

    private static string? ResolveStagingFile(string stagingRoot, UploadSession? session)
    {
        if (session is null)
        {
            return null;
        }

        if (!string.IsNullOrWhiteSpace(session.StagingFilePath))
        {
            try
            {
                var fileName = Path.GetFileName(session.StagingFilePath);
                var candidate = PathSegmentSanitizer.CombineWithinRoot(stagingRoot, fileName);
                if (System.IO.File.Exists(candidate))
                {
                    return candidate;
                }
            }
            catch
            {
                // Fall back to TusResourceId
            }
        }

        if (!string.IsNullOrWhiteSpace(session.TusResourceId) &&
            !session.TusResourceId.StartsWith(StagingQuotaGuard.PendingResourcePrefix, StringComparison.Ordinal))
        {
            try
            {
                return PathSegmentSanitizer.CombineWithinRoot(stagingRoot, session.TusResourceId);
            }
            catch
            {
                return null;
            }
        }

        return null;
    }

    private static string? NormalizeOptionalSha256(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        var trimmed = raw.Trim().ToLowerInvariant();
        if (trimmed.Length != 64 || !trimmed.All(Uri.IsHexDigit))
        {
            return null;
        }

        return trimmed;
    }
}
