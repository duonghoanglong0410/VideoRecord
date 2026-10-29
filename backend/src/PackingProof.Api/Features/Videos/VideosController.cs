using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using PackingProof.Api.Common;
using PackingProof.Api.Features.Recordings;
using PackingProof.Api.Features.Uploads;
using PackingProof.Core.Abstractions;
using PackingProof.Core.Entities;
using PackingProof.Core.Enums;
using PackingProof.Core.Permissions;
using PackingProof.Core.Storage;
using PackingProof.Core.Tracking;
using PackingProof.Infrastructure.Configuration;
using PackingProof.Infrastructure.Persistence;
using PackingProof.Infrastructure.Storage;
using PackingProof.Infrastructure.Uploads;

namespace PackingProof.Api.Features.Videos;

[ApiController]
[Route("api/videos")]
[Authorize]
public sealed class VideosController : ControllerBase
{
    private static readonly TimeSpan DefaultUploadSessionLifetime = TimeSpan.FromHours(24);

    private readonly PackingProofDbContext _db;
    private readonly IScopeAuthorizationService _scopeAuth;
    private readonly IVideoStorage _videoStorage;
    private readonly ITrackingCodeParser _trackingParser;
    private readonly IOrderLinkResolver _orderLinkResolver;
    private readonly IAuditLogger _auditLogger;
    private readonly StagingQuotaGuard _stagingQuotaGuard;
    private readonly PackingProofOptions _options;

    public VideosController(
        PackingProofDbContext db,
        IScopeAuthorizationService scopeAuth,
        IVideoStorage videoStorage,
        ITrackingCodeParser trackingParser,
        IOrderLinkResolver orderLinkResolver,
        IAuditLogger auditLogger,
        StagingQuotaGuard stagingQuotaGuard,
        PackingProofOptions options)
    {
        _db = db;
        _scopeAuth = scopeAuth;
        _videoStorage = videoStorage;
        _trackingParser = trackingParser;
        _orderLinkResolver = orderLinkResolver;
        _auditLogger = auditLogger;
        _stagingQuotaGuard = stagingQuotaGuard;
        _options = options;
    }

    [HttpGet]
    public async Task<ActionResult<PagedVideosResponse>> ListVideos(
        [FromQuery] string? q = null,
        [FromQuery] string? trackingNumber = null,
        [FromQuery] bool exact = false,
        [FromQuery] Guid? shopId = null,
        [FromQuery] Guid? warehouseId = null,
        [FromQuery] Guid? ownerUserId = null,
        [FromQuery] bool mineOnly = false,
        [FromQuery] CaptureStatus? captureStatus = null,
        [FromQuery] StorageStatus? storageStatus = null,
        [FromQuery] PreviewStatus? previewStatus = null,
        [FromQuery] bool? hold = null,
        [FromQuery] RecordingSource? source = null,
        [FromQuery] string? fromDate = null,
        [FromQuery] string? toDate = null,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        CancellationToken ct = default)
    {
        var userId = HttpContext.GetRequiredUserId();
        var access = await _scopeAuth.GetEffectiveAccessAsync(userId, ct);

        var baseQuery = _db.Recordings
            .AsNoTracking()
            .Where(r => !r.IsSoftDeleted);

        if (!ScopeQueryExtensions.TryApplyRecordingPermissionScope(
            baseQuery,
            access,
            PermissionCatalog.VideoView,
            out var query))
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "video.list",
                EntityType: "Recording",
                Outcome: AuditOutcome.Denied,
                ActorUserId: userId,
                ActorEmail: HttpContext.GetUserEmail(),
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new { reason = "MISSING_VIDEO_VIEW_SCOPE" }), ct);

            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "FORBIDDEN",
                "Tài khoản của bạn không có quyền tra cứu danh sách video."));
        }

        if (!StoragePathBuilder.TryParseHoChiMinhFromDateUtc(fromDate, out var fromUtc) ||
            !StoragePathBuilder.TryParseHoChiMinhToDateExclusiveUtc(toDate, out var toExclusiveUtc))
        {
            return BadRequest(new ApiErrorResponse(
                "INVALID_DATE_RANGE",
                "Định dạng ngày lọc không hợp lệ. Vui lòng sử dụng định dạng yyyy-MM-dd (theo múi giờ Asia/Ho_Chi_Minh)."));
        }

        if (fromUtc.HasValue && toExclusiveUtc.HasValue && fromUtc.Value >= toExclusiveUtc.Value)
        {
            return BadRequest(new ApiErrorResponse(
                "INVALID_DATE_RANGE",
                "Ngày bắt đầu không được lớn hơn ngày kết thúc."));
        }

        if (mineOnly)
        {
            query = query.Where(r => r.OwnerUserId == userId);
        }

        if (ownerUserId.HasValue)
        {
            query = query.Where(r => r.OwnerUserId == ownerUserId.Value);
        }

        if (shopId.HasValue)
        {
            query = query.Where(r => r.ShopId == shopId.Value);
        }

        if (warehouseId.HasValue)
        {
            query = query.Where(r => r.WarehouseId == warehouseId.Value);
        }

        if (captureStatus.HasValue)
        {
            query = query.Where(r => r.CaptureStatus == captureStatus.Value);
        }

        if (storageStatus.HasValue)
        {
            query = query.Where(r => r.StorageStatus == storageStatus.Value);
        }

        if (previewStatus.HasValue)
        {
            query = query.Where(r => r.PreviewStatus == previewStatus.Value);
        }

        if (hold.HasValue)
        {
            query = query.Where(r => r.Hold == hold.Value);
        }

        if (source.HasValue)
        {
            query = query.Where(r => r.Source == source.Value);
        }

        // Preserve leading zeros and exact string semantics (never parse tracking numbers as integers)
        if (!string.IsNullOrWhiteSpace(trackingNumber))
        {
            var term = trackingNumber.Trim();
            if (exact)
            {
                query = query.Where(r => r.TrackingNumber == term);
            }
            else
            {
                var pattern = $"%{ScopeQueryExtensions.EscapeLikePattern(term)}%";
                query = query.Where(r => EF.Functions.ILike(r.TrackingNumber, pattern, "\\"));
            }
        }

        if (!string.IsNullOrWhiteSpace(q))
        {
            var qTerm = q.Trim();
            if (exact)
            {
                query = query.Where(r =>
                    r.TrackingNumber == qTerm ||
                    (r.TikTokOrderId != null && r.TikTokOrderId == qTerm));
            }
            else
            {
                var qPattern = $"%{ScopeQueryExtensions.EscapeLikePattern(qTerm)}%";
                query = query.Where(r =>
                    EF.Functions.ILike(r.TrackingNumber, qPattern, "\\") ||
                    (r.TikTokOrderId != null && EF.Functions.ILike(r.TikTokOrderId, qPattern, "\\")));
            }
        }

        if (fromUtc.HasValue)
        {
            var start = fromUtc.Value;
            query = query.Where(r => r.CreatedAtUtc >= start);
        }

        if (toExclusiveUtc.HasValue)
        {
            var end = toExclusiveUtc.Value;
            query = query.Where(r => r.CreatedAtUtc < end);
        }

        var normalizedPage = Math.Max(1, page);
        var normalizedPageSize = Math.Clamp(pageSize, 1, 100);

        var totalCount = await query.CountAsync(ct);
        var totalPages = totalCount == 0
            ? 0
            : (int)Math.Ceiling(totalCount / (double)normalizedPageSize);

        var fallbackStorageMode = _options.StorageMode;

        var items = await query
            .OrderByDescending(r => r.CreatedAtUtc)
            .ThenByDescending(r => r.Id)
            .Skip((normalizedPage - 1) * normalizedPageSize)
            .Take(normalizedPageSize)
            .Select(r => new VideoListItemDto(
                r.Id,
                r.TrackingNumber,
                r.CarrierCode,
                r.TikTokOrderId,
                r.ShopId,
                r.Shop.Name,
                r.WarehouseId,
                r.Warehouse.Name,
                r.OwnerUserId,
                r.OwnerUser.Email ?? string.Empty,
                r.OwnerUser.FullName,
                r.Source,
                r.ManualEntryReason != null && r.ManualEntryReason != "",
                r.CaptureStatus,
                r.StorageStatus,
                r.PreviewStatus,
                r.VideoAssets
                    .Where(a => a.Kind == AssetKind.Original)
                    .Select(a => (StorageMode?)a.StorageProfile.Mode)
                    .FirstOrDefault() ?? fallbackStorageMode,
                r.DurationSeconds,
                r.Width,
                r.Height,
                r.ActualMimeType,
                r.VideoAssets
                    .Where(a => a.Kind == AssetKind.Original)
                    .Select(a => (long?)a.SizeBytes)
                    .FirstOrDefault(),
                r.VideoAssets.Any(a => a.Kind == AssetKind.Preview),
                r.Hold,
                r.HoldReason,
                r.Notes.Count,
                r.DeletionRequests.Any(d => d.Status == DeletionRequestStatus.Pending),
                r.StartedAtUtc,
                r.EndedAtUtc,
                r.StoredAtUtc,
                r.CreatedAtUtc,
                r.LastErrorCode,
                r.UserSafeErrorMessage))
            .ToListAsync(ct);

        return Ok(new PagedVideosResponse(
            Items: items,
            Page: normalizedPage,
            PageSize: normalizedPageSize,
            TotalCount: totalCount,
            TotalPages: totalPages));
    }

    [HttpGet("{id:guid}")]
    public async Task<ActionResult<VideoDetailDto>> GetVideoDetail(Guid id, CancellationToken ct)
    {
        var userId = HttpContext.GetRequiredUserId();
        var access = await _scopeAuth.GetEffectiveAccessAsync(userId, ct);

        var recording = await _db.Recordings
            .AsNoTracking()
            .AsSplitQuery()
            .Include(r => r.Shop)
            .Include(r => r.Warehouse)
            .Include(r => r.PackingStation)
            .Include(r => r.OwnerUser)
            .Include(r => r.LinkedFromRecording)
            .Include(r => r.VideoAssets)
                .ThenInclude(a => a.StorageProfile)
            .Include(r => r.Notes)
                .ThenInclude(n => n.AuthorUser)
            .Include(r => r.DeletionRequests)
                .ThenInclude(d => d.RequestedByUser)
            .Include(r => r.DeletionRequests)
                .ThenInclude(d => d.ReviewedByUser)
            .FirstOrDefaultAsync(r => r.Id == id && !r.IsSoftDeleted, ct);

        if (recording is null)
        {
            return NotFound(new ApiErrorResponse(
                "VIDEO_NOT_FOUND",
                "Không tìm thấy bản ghi video yêu cầu."));
        }

        var resourceScope = new ResourceScopeContext(
            OwnerUserId: recording.OwnerUserId,
            ShopId: recording.ShopId,
            WarehouseId: recording.WarehouseId);

        if (!ScopeQueryExtensions.HasEffectivePermissionInMemory(access, PermissionCatalog.VideoView, resourceScope))
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "video.view",
                EntityType: "Recording",
                EntityId: recording.Id.ToString(),
                Outcome: AuditOutcome.Denied,
                ActorUserId: userId,
                ActorEmail: HttpContext.GetUserEmail(),
                ShopId: recording.ShopId,
                WarehouseId: recording.WarehouseId,
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new { reason = "OUT_OF_SCOPE_OR_MISSING_VIDEO_VIEW" }), ct);

            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "FORBIDDEN",
                "Bạn không có quyền xem thông tin video ngoài phạm vi được cấp."));
        }

        var originalAsset = recording.VideoAssets.FirstOrDefault(a => a.Kind == AssetKind.Original);
        var previewAsset = recording.VideoAssets.FirstOrDefault(a => a.Kind == AssetKind.Preview);
        var effectiveStorageMode = originalAsset?.StorageProfile.Mode ?? _options.StorageMode;

        var notes = recording.Notes
            .OrderByDescending(n => n.CreatedAtUtc)
            .Select(n => new VideoNoteDto(
                n.Id,
                n.RecordingId,
                n.AuthorUserId,
                n.AuthorUser.Email ?? string.Empty,
                n.AuthorUser.FullName,
                n.Content,
                n.CreatedAtUtc))
            .ToList();

        var deletionRequests = recording.DeletionRequests
            .OrderByDescending(d => d.CreatedAtUtc)
            .Select(d => new VideoDeletionRequestSummaryDto(
                d.Id,
                d.RecordingId,
                d.RequestedByUserId,
                d.RequestedByUser.Email ?? string.Empty,
                d.RequestedByUser.FullName,
                d.Reason,
                d.Status,
                d.ReviewedByUserId,
                d.ReviewedByUser?.Email,
                d.ReviewedByUser?.FullName,
                d.ReviewNote,
                d.CreatedAtUtc,
                d.ReviewedAtUtc))
            .ToList();

        var callerCreateScope = new ResourceScopeContext(
            OwnerUserId: userId,
            ShopId: recording.ShopId,
            WarehouseId: recording.WarehouseId);

        return Ok(new VideoDetailDto(
            Id: recording.Id,
            TrackingNumber: recording.TrackingNumber,
            CarrierCode: recording.CarrierCode,
            TikTokOrderId: recording.TikTokOrderId,
            ShopId: recording.ShopId,
            ShopCode: recording.Shop.Code,
            ShopName: recording.Shop.Name,
            WarehouseId: recording.WarehouseId,
            WarehouseCode: recording.Warehouse.Code,
            WarehouseName: recording.Warehouse.Name,
            PackingStationName: recording.PackingStation?.Name,
            OwnerUserId: recording.OwnerUserId,
            OwnerEmail: recording.OwnerUser.Email ?? string.Empty,
            OwnerFullName: recording.OwnerUser.FullName,
            Source: recording.Source,
            IsManualCode: !string.IsNullOrWhiteSpace(recording.ManualEntryReason),
            ManualEntryReason: recording.ManualEntryReason,
            LinkedFromRecordingId: recording.LinkedFromRecordingId,
            LinkedFromTrackingNumber: recording.LinkedFromRecording?.TrackingNumber,
            CaptureStatus: recording.CaptureStatus,
            StorageStatus: recording.StorageStatus,
            PreviewStatus: recording.PreviewStatus,
            StorageMode: effectiveStorageMode,
            DurationSeconds: recording.DurationSeconds,
            Width: recording.Width,
            Height: recording.Height,
            ActualMimeType: recording.ActualMimeType ?? originalAsset?.MimeType,
            ActualContainer: recording.ActualContainer,
            VideoCodec: recording.VideoCodec,
            AudioCodec: recording.AudioCodec,
            OriginalSizeBytes: originalAsset?.SizeBytes,
            OriginalSha256: originalAsset?.Sha256,
            HasOriginalAsset: originalAsset is not null,
            HasPreviewAsset: previewAsset is not null && recording.PreviewStatus == PreviewStatus.Ready,
            PreviewSizeBytes: previewAsset?.SizeBytes,
            StartedAtUtc: recording.StartedAtUtc,
            EndedAtUtc: recording.EndedAtUtc,
            ServerReceivedAtUtc: recording.ServerReceivedAtUtc,
            StoredAtUtc: recording.StoredAtUtc,
            CreatedAtUtc: recording.CreatedAtUtc,
            LastErrorCode: recording.LastErrorCode,
            UserSafeErrorMessage: recording.UserSafeErrorMessage,
            IsRetryable: recording.IsRetryable,
            Hold: recording.Hold,
            HoldReason: recording.HoldReason,
            HoldUpdatedByUserId: recording.HoldUpdatedByUserId,
            HoldUpdatedAtUtc: recording.HoldUpdatedAtUtc,
            Notes: notes,
            DeletionRequests: deletionRequests,
            CanDownload: ScopeQueryExtensions.HasEffectivePermissionInMemory(access, PermissionCatalog.VideoDownload, resourceScope),
            CanNote: ScopeQueryExtensions.HasEffectivePermissionInMemory(access, PermissionCatalog.VideoNote, resourceScope),
            CanHold: ScopeQueryExtensions.HasEffectivePermissionInMemory(access, PermissionCatalog.VideoHold, resourceScope),
            CanRequestDelete: ScopeQueryExtensions.HasEffectivePermissionInMemory(access, PermissionCatalog.VideoDeleteRequest, resourceScope),
            CanApproveDelete: ScopeQueryExtensions.HasEffectivePermissionInMemory(access, PermissionCatalog.VideoDeleteApprove, resourceScope),
            CanReRecordWithCorrectCode: ScopeQueryExtensions.HasEffectivePermissionInMemory(access, PermissionCatalog.RecordingCreate, callerCreateScope)));
    }

    [HttpGet("{id:guid}/stream")]
    public Task<IActionResult> StreamVideoGet(
        Guid id,
        [FromQuery] string? variant = "auto",
        CancellationToken ct = default) =>
        StreamVideoCoreAsync(id, variant, ct);

    [HttpHead("{id:guid}/stream")]
    public Task<IActionResult> StreamVideoHead(
        Guid id,
        [FromQuery] string? variant = "auto",
        CancellationToken ct = default) =>
        StreamVideoCoreAsync(id, variant, ct);

    [HttpGet("{id:guid}/download")]
    public async Task<IActionResult> DownloadOriginalVideo(Guid id, CancellationToken ct)
    {
        var userId = HttpContext.GetRequiredUserId();
        var userEmail = HttpContext.GetUserEmail();

        var recording = await _db.Recordings
            .AsNoTracking()
            .Include(r => r.VideoAssets)
            .FirstOrDefaultAsync(r => r.Id == id && !r.IsSoftDeleted, ct);

        if (recording is null)
        {
            return NotFound(new ApiErrorResponse(
                "VIDEO_NOT_FOUND",
                "Không tìm thấy bản ghi video yêu cầu."));
        }

        var resourceScope = new ResourceScopeContext(
            OwnerUserId: recording.OwnerUserId,
            ShopId: recording.ShopId,
            WarehouseId: recording.WarehouseId);

        var canDownload = await _scopeAuth.HasPermissionAsync(
            userId,
            PermissionCatalog.VideoDownload,
            resourceScope,
            ct);

        if (!canDownload)
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "video.download",
                EntityType: "Recording",
                EntityId: recording.Id.ToString(),
                Outcome: AuditOutcome.Denied,
                ActorUserId: userId,
                ActorEmail: userEmail,
                ShopId: recording.ShopId,
                WarehouseId: recording.WarehouseId,
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new
                {
                    reason = "MISSING_VIDEO_DOWNLOAD_PERMISSION_OR_SCOPE",
                    trackingNumber = recording.TrackingNumber
                }), ct);

            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "FORBIDDEN",
                "Tài khoản của bạn không có quyền tải xuống tệp video gốc (yêu cầu quyền video.download riêng)."));
        }

        var originalAsset = recording.VideoAssets.FirstOrDefault(a => a.Kind == AssetKind.Original);
        if (recording.StorageStatus != StorageStatus.Stored ||
            originalAsset is null ||
            string.IsNullOrWhiteSpace(originalAsset.RelativePath))
        {
            return Conflict(new ApiErrorResponse(
                "VIDEO_NOT_STORED",
                "Tệp video gốc chưa hoàn tất kiểm tra và lưu trữ nên chưa thể tải xuống."));
        }

        Stream stream;
        try
        {
            stream = await _videoStorage.OpenReadAsync(originalAsset.RelativePath, ct);
        }
        catch (Exception ex) when (ex is StorageUnavailableException or IOException or UnauthorizedAccessException)
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "video.download",
                EntityType: "Recording",
                EntityId: recording.Id.ToString(),
                Outcome: AuditOutcome.Failed,
                ActorUserId: userId,
                ActorEmail: userEmail,
                ShopId: recording.ShopId,
                WarehouseId: recording.WarehouseId,
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new
                {
                    errorCode = ex is StorageUnavailableException sue ? sue.ErrorCode : "STORAGE_FILE_UNAVAILABLE",
                    trackingNumber = recording.TrackingNumber
                }), ct);

            return StorageFileUnavailableResult(ex);
        }

        var extension = ResolveSafeDownloadExtension(recording.ActualContainer, originalAsset.RelativePath);
        var safeSegment = string.IsNullOrWhiteSpace(recording.SafeTrackingSegment)
            ? PathSegmentSanitizer.ToSafeSegment(recording.TrackingNumber)
            : PathSegmentSanitizer.ToSafeSegment(recording.SafeTrackingSegment);
        var downloadFileName = $"{safeSegment}_{recording.Id:D}{extension}";
        var mimeType = string.IsNullOrWhiteSpace(originalAsset.MimeType)
            ? "application/octet-stream"
            : originalAsset.MimeType;

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "video.download",
            EntityType: "Recording",
            EntityId: recording.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: userId,
            ActorEmail: userEmail,
            ShopId: recording.ShopId,
            WarehouseId: recording.WarehouseId,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new
            {
                trackingNumber = recording.TrackingNumber,
                downloadFileName,
                sizeBytes = originalAsset.SizeBytes,
                sha256 = originalAsset.Sha256
            }), ct);

        Response.Headers.CacheControl = "private, no-store";
        Response.Headers["X-Content-Type-Options"] = "nosniff";

        return File(
            stream,
            mimeType,
            fileDownloadName: downloadFileName,
            enableRangeProcessing: true);
    }

    [HttpPost("import")]
    public async Task<ActionResult<CreateVideoImportResponse>> CreateImportedVideo(
        [FromBody] CreateVideoImportRequest request,
        CancellationToken ct)
    {
        var userId = HttpContext.GetRequiredUserId();
        var userEmail = HttpContext.GetUserEmail();

        var resourceContext = new ResourceScopeContext(
            OwnerUserId: userId,
            ShopId: request.ShopId,
            WarehouseId: request.WarehouseId);

        var canImport = request.ShopId != Guid.Empty &&
                        request.WarehouseId != Guid.Empty &&
                        await _scopeAuth.HasPermissionAsync(
                            userId,
                            PermissionCatalog.VideoImport,
                            resourceContext,
                            ct);

        if (!canImport)
        {
            var hasAnyImport = await _scopeAuth.HasAnyScopeForPermissionAsync(
                userId,
                PermissionCatalog.VideoImport,
                ct);

            if (!hasAnyImport || (request.ShopId != Guid.Empty && request.WarehouseId != Guid.Empty))
            {
                await _auditLogger.AppendAsync(new AuditEntryRequest(
                    Action: "video.import_created",
                    EntityType: "Recording",
                    Outcome: AuditOutcome.Denied,
                    ActorUserId: userId,
                    ActorEmail: userEmail,
                    ShopId: request.ShopId == Guid.Empty ? null : request.ShopId,
                    WarehouseId: request.WarehouseId == Guid.Empty ? null : request.WarehouseId,
                    IpAddress: HttpContext.GetClientIp(),
                    UserAgent: HttpContext.GetUserAgent(),
                    Metadata: new { reason = "MISSING_VIDEO_IMPORT_PERMISSION_OR_SCOPE" }), ct);

                return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                    "FORBIDDEN",
                    "Tài khoản của bạn không được cấp quyền nhập tệp video có sẵn (video.import) tại Shop/Kho này."));
            }
        }

        var warehouse = await _db.Warehouses
            .AsNoTracking()
            .Include(w => w.Shop)
            .FirstOrDefaultAsync(w =>
                w.Id == request.WarehouseId &&
                w.ShopId == request.ShopId &&
                w.IsActive &&
                w.Shop.IsActive, ct);

        if (warehouse is null)
        {
            return BadRequest(new ApiErrorResponse(
                "INVALID_SHOP_WAREHOUSE",
                "Shop hoặc Kho được chọn không tồn tại, đã ngưng hoạt động hoặc không khớp với nhau."));
        }

        if (request.PackingStationId.HasValue)
        {
            var validStation = await _db.PackingStations
                .AsNoTracking()
                .AnyAsync(p =>
                    p.Id == request.PackingStationId.Value &&
                    p.WarehouseId == request.WarehouseId &&
                    p.IsActive, ct);

            if (!validStation)
            {
                return BadRequest(new ApiErrorResponse(
                    "INVALID_PACKING_STATION",
                    "Bàn đóng gói được chọn không tồn tại hoặc không thuộc kho hiện tại."));
            }
        }

        var isManual = request.IsManualEntry || request.FormatHint == BarcodeFormatHint.ManualEntry;
        string? normalizedManualReason = null;

        if (isManual)
        {
            var canManualCode = await _scopeAuth.HasPermissionAsync(
                userId,
                PermissionCatalog.RecordingManualCode,
                resourceContext,
                ct);

            if (!canManualCode)
            {
                await _auditLogger.AppendAsync(new AuditEntryRequest(
                    Action: "recording.manual_code",
                    EntityType: "Recording",
                    Outcome: AuditOutcome.Denied,
                    ActorUserId: userId,
                    ActorEmail: userEmail,
                    ShopId: request.ShopId,
                    WarehouseId: request.WarehouseId,
                    IpAddress: HttpContext.GetClientIp(),
                    UserAgent: HttpContext.GetUserAgent(),
                    Metadata: new { reason = "MISSING_MANUAL_CODE_PERMISSION_FOR_IMPORT" }), ct);

                return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                    "MANUAL_CODE_FORBIDDEN",
                    "Tài khoản của bạn không được cấp quyền nhập mã vận đơn thủ công."));
            }

            normalizedManualReason = request.ManualEntryReason?.Trim();
            if (string.IsNullOrWhiteSpace(normalizedManualReason) || normalizedManualReason.Length < 3)
            {
                return BadRequest(new ApiErrorResponse(
                    "MANUAL_REASON_REQUIRED",
                    "Vui lòng nhập lý do rõ ràng (tối thiểu 3 ký tự) khi nhập mã vận đơn thủ công."));
            }

            if (normalizedManualReason.Length > 500)
            {
                return BadRequest(new ApiErrorResponse(
                    "MANUAL_REASON_TOO_LONG",
                    "Lý do nhập mã thủ công không được vượt quá 500 ký tự."));
            }
        }

        var rawInput = request.RawCode ?? request.TrackingNumber;
        var effectiveFormatHint = isManual ? BarcodeFormatHint.ManualEntry : request.FormatHint;
        var parsed = _trackingParser.Parse(rawInput, effectiveFormatHint);
        if (!parsed.IsValid || string.IsNullOrEmpty(parsed.TrackingNumber))
        {
            return BadRequest(new ApiErrorResponse(
                parsed.ErrorCode ?? "INVALID_TRACKING_CODE",
                parsed.UserSafeErrorMessage ?? "Mã vận đơn không hợp lệ. Vui lòng quét hoặc kiểm tra lại mã trên tem đơn hàng."));
        }

        string? previousLinkedTrackingNumber = null;
        if (request.LinkedFromRecordingId.HasValue)
        {
            var linkedRecording = await _db.Recordings
                .AsNoTracking()
                .FirstOrDefaultAsync(r =>
                    r.Id == request.LinkedFromRecordingId.Value &&
                    !r.IsSoftDeleted, ct);

            if (linkedRecording is null || linkedRecording.ShopId != request.ShopId)
            {
                return BadRequest(new ApiErrorResponse(
                    "INVALID_LINKED_RECORDING",
                    "Bản ghi trước cần liên kết không tồn tại hoặc không thuộc cùng Shop."));
            }

            var canReferenceLinked = linkedRecording.OwnerUserId == userId ||
                await _scopeAuth.HasPermissionAsync(
                    userId,
                    PermissionCatalog.VideoView,
                    new ResourceScopeContext(
                        linkedRecording.OwnerUserId,
                        linkedRecording.ShopId,
                        linkedRecording.WarehouseId),
                    ct);

            if (!canReferenceLinked)
            {
                return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                    "LINKED_RECORDING_FORBIDDEN",
                    "Bạn không có quyền liên kết tới bản ghi gốc này."));
            }

            previousLinkedTrackingNumber = linkedRecording.TrackingNumber;
        }

        var profile = await _db.StorageProfiles
            .AsNoTracking()
            .OrderBy(p => p.Name)
            .FirstOrDefaultAsync(ct);

        var maxUploadBytes = profile?.MaxUploadBytes ?? _options.MaxUploadBytes;
        if (request.ExpectedBytes.HasValue)
        {
            if (request.ExpectedBytes.Value <= 0)
            {
                return BadRequest(new ApiErrorResponse(
                    "INVALID_EXPECTED_BYTES",
                    "Dung lượng tệp video nhập vào phải lớn hơn 0 byte."));
            }

            if (request.ExpectedBytes.Value > maxUploadBytes)
            {
                return StatusCode(StatusCodes.Status413PayloadTooLarge, new ApiErrorResponse(
                    "UPLOAD_SIZE_EXCEEDED",
                    $"Dung lượng tệp ({request.ExpectedBytes.Value:N0} byte) vượt quá giới hạn tối đa cho phép ({maxUploadBytes:N0} byte)."));
            }
        }

        var safeSegment = PathSegmentSanitizer.ToSafeSegment(parsed.TrackingNumber);
        var orderResolution = await _orderLinkResolver.ResolveAsync(request.ShopId, parsed.TrackingNumber, ct);
        var carrierCode = parsed.CarrierCode ?? orderResolution?.CarrierCode;
        var tikTokOrderId = parsed.TikTokOrderId ?? orderResolution?.TikTokOrderId;

        var existingCount = await _db.Recordings
            .AsNoTracking()
            .CountAsync(r =>
                r.ShopId == request.ShopId &&
                r.TrackingNumber == parsed.TrackingNumber &&
                !r.IsSoftDeleted &&
                r.CaptureStatus != CaptureStatus.Cancelled, ct);

        var warningMessage = existingCount > 0
            ? $"Mã vận đơn {parsed.TrackingNumber} đã có {existingCount} bản ghi trước đó trong Shop này. Bản nhập mới sẽ được lưu thành phiên riêng biệt, không ghi đè video cũ."
            : null;

        var now = DateTime.UtcNow;
        var recording = new Recording
        {
            Id = Guid.NewGuid(),
            OwnerUserId = userId,
            ShopId = request.ShopId,
            WarehouseId = request.WarehouseId,
            PackingStationId = request.PackingStationId,
            TrackingNumber = parsed.TrackingNumber,
            SafeTrackingSegment = safeSegment,
            CarrierCode = carrierCode,
            TikTokOrderId = tikTokOrderId,
            Source = RecordingSource.Imported,
            ManualEntryReason = normalizedManualReason,
            LinkedFromRecordingId = request.LinkedFromRecordingId,
            CaptureStatus = CaptureStatus.Captured,
            StorageStatus = StorageStatus.AwaitingUpload,
            PreviewStatus = PreviewStatus.NotRequired,
            ClientMimeType = NormalizeOptionalMime(request.ClientMimeType),
            StartedAtUtc = now,
            EndedAtUtc = now,
            CreatedAtUtc = now,
            UpdatedAtUtc = now
        };

        UploadSessionDto? uploadSessionDto = null;

        if (request.ExpectedBytes.HasValue)
        {
            var expectedBytes = request.ExpectedBytes.Value;
            var quotaCheckResult = await _stagingQuotaGuard.RunUnderReservationLockAsync<ActionResult?>(async innerCt =>
            {
                var (allowed, _) = await _stagingQuotaGuard.CanAccommodateAsync(
                    expectedBytes,
                    excludeRecordingId: recording.Id,
                    ct: innerCt);

                if (!allowed)
                {
                    return StatusCode(StatusCodes.Status507InsufficientStorage, new ApiErrorResponse(
                        "STAGING_CAPACITY_EXCEEDED",
                        "Vùng lưu đệm tải lên trên máy chủ hiện đã đầy. Vui lòng chờ hệ thống xử lý bớt hàng đợi rồi thử lại."));
                }

                var sessionId = Guid.NewGuid();
                var uploadSession = new UploadSession
                {
                    Id = sessionId,
                    RecordingId = recording.Id,
                    OwnerUserId = userId,
                    TusResourceId = $"{StagingQuotaGuard.PendingResourcePrefix}{sessionId:N}",
                    ExpectedBytes = expectedBytes,
                    ReceivedBytes = 0,
                    ClientSha256 = NormalizeOptionalSha256(request.ClientSha256),
                    Status = UploadSessionStatus.Initiated,
                    StagingFilePath = string.Empty,
                    ExpiresAtUtc = now.Add(DefaultUploadSessionLifetime),
                    CreatedAtUtc = now
                };

                _db.Recordings.Add(recording);
                _db.UploadSessions.Add(uploadSession);
                await _db.SaveChangesAsync(innerCt);

                uploadSessionDto = new UploadSessionDto(
                    UploadSessionId: uploadSession.Id,
                    RecordingId: recording.Id,
                    TusResourceId: null,
                    TusUploadUrl: null,
                    ExpectedBytes: uploadSession.ExpectedBytes,
                    ReceivedBytes: 0,
                    RecommendedChunkBytes: _options.UploadChunkBytes,
                    SessionStatus: uploadSession.Status,
                    RecordingStorageStatus: recording.StorageStatus,
                    ExpiresAtUtc: uploadSession.ExpiresAtUtc);

                return null;
            }, ct);

            if (quotaCheckResult is not null)
            {
                return quotaCheckResult;
            }
        }
        else
        {
            _db.Recordings.Add(recording);
            await _db.SaveChangesAsync(ct);
        }

        if (isManual)
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "recording.manual_code",
                EntityType: "Recording",
                EntityId: recording.Id.ToString(),
                Outcome: AuditOutcome.Success,
                ActorUserId: userId,
                ActorEmail: userEmail,
                ShopId: recording.ShopId,
                WarehouseId: recording.WarehouseId,
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new
                {
                    trackingNumber = recording.TrackingNumber,
                    manualEntryReason = recording.ManualEntryReason,
                    source = RecordingSource.Imported.ToString()
                }), ct);
        }

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "video.import_created",
            EntityType: "Recording",
            EntityId: recording.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: userId,
            ActorEmail: userEmail,
            ShopId: recording.ShopId,
            WarehouseId: recording.WarehouseId,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new
            {
                trackingNumber = recording.TrackingNumber,
                safeTrackingSegment = recording.SafeTrackingSegment,
                source = RecordingSource.Imported.ToString(),
                expectedBytes = request.ExpectedBytes,
                linkedFromRecordingId = recording.LinkedFromRecordingId,
                previousLinkedTrackingNumber
            }), ct);

        var owner = await _db.Users
            .AsNoTracking()
            .Where(u => u.Id == userId)
            .Select(u => new { Email = u.Email ?? string.Empty, u.FullName })
            .FirstAsync(ct);

        var limits = new RecordingRuntimeLimitsDto(
            MaxRecordingSeconds: profile?.MaxRecordingSeconds ?? _options.MaxRecordingSeconds,
            MaxUploadBytes: maxUploadBytes,
            MaxLocalPendingRecordings: profile?.MaxLocalPendingRecordings ?? _options.MaxLocalPendingRecordings,
            EnableAudioRecording: profile?.EnableAudioRecording ?? _options.EnableAudioRecording);

        var recordingDto = RecordingsController.MapRecordingDto(
            recording,
            owner.Email,
            owner.FullName,
            warehouse.Shop.Name,
            warehouse.Name,
            _options.StorageMode);

        return CreatedAtAction(
            nameof(GetVideoDetail),
            new { id = recording.Id },
            new CreateVideoImportResponse(
                Recording: recordingDto,
                UploadSession: uploadSessionDto,
                ExistingRecordingCount: existingCount,
                WarningMessage: warningMessage,
                Limits: limits));
    }

    [HttpPost("{id:guid}/notes")]
    public async Task<ActionResult<VideoNoteDto>> AddNote(
        Guid id,
        [FromBody] CreateVideoNoteRequest request,
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
                "VIDEO_NOT_FOUND",
                "Không tìm thấy bản ghi video yêu cầu."));
        }

        var resourceScope = new ResourceScopeContext(
            OwnerUserId: recording.OwnerUserId,
            ShopId: recording.ShopId,
            WarehouseId: recording.WarehouseId);

        var canNote = await _scopeAuth.HasPermissionAsync(
            userId,
            PermissionCatalog.VideoNote,
            resourceScope,
            ct);

        if (!canNote)
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "video.note_added",
                EntityType: "Recording",
                EntityId: recording.Id.ToString(),
                Outcome: AuditOutcome.Denied,
                ActorUserId: userId,
                ActorEmail: userEmail,
                ShopId: recording.ShopId,
                WarehouseId: recording.WarehouseId,
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new { reason = "MISSING_VIDEO_NOTE_PERMISSION_OR_SCOPE" }), ct);

            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "FORBIDDEN",
                "Bạn không có quyền thêm ghi chú cho video này."));
        }

        var content = request.Content?.Trim() ?? string.Empty;
        if (string.IsNullOrWhiteSpace(content))
        {
            return BadRequest(new ApiErrorResponse(
                "NOTE_CONTENT_REQUIRED",
                "Nội dung ghi chú không được để trống."));
        }

        if (content.Length > 2000)
        {
            return BadRequest(new ApiErrorResponse(
                "NOTE_CONTENT_TOO_LONG",
                "Nội dung ghi chú không được vượt quá 2000 ký tự."));
        }

        var note = new VideoNote
        {
            Id = Guid.NewGuid(),
            RecordingId = recording.Id,
            AuthorUserId = userId,
            Content = content,
            CreatedAtUtc = DateTime.UtcNow
        };

        _db.VideoNotes.Add(note);
        await _db.SaveChangesAsync(ct);

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "video.note_added",
            EntityType: "Recording",
            EntityId: recording.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: userId,
            ActorEmail: userEmail,
            ShopId: recording.ShopId,
            WarehouseId: recording.WarehouseId,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new
            {
                noteId = note.Id,
                trackingNumber = recording.TrackingNumber,
                contentLength = content.Length
            }), ct);

        var author = await _db.Users
            .AsNoTracking()
            .Where(u => u.Id == userId)
            .Select(u => new { Email = u.Email ?? string.Empty, u.FullName })
            .FirstAsync(ct);

        return StatusCode(StatusCodes.Status201Created, new VideoNoteDto(
            note.Id,
            note.RecordingId,
            note.AuthorUserId,
            author.Email,
            author.FullName,
            note.Content,
            note.CreatedAtUtc));
    }

    [HttpPut("{id:guid}/hold")]
    public async Task<ActionResult<VideoHoldStateDto>> UpdateHold(
        Guid id,
        [FromBody] UpdateVideoHoldRequest request,
        CancellationToken ct)
    {
        var userId = HttpContext.GetRequiredUserId();
        var userEmail = HttpContext.GetUserEmail();

        var recording = await _db.Recordings
            .FirstOrDefaultAsync(r => r.Id == id && !r.IsSoftDeleted, ct);

        if (recording is null)
        {
            return NotFound(new ApiErrorResponse(
                "VIDEO_NOT_FOUND",
                "Không tìm thấy bản ghi video yêu cầu."));
        }

        var resourceScope = new ResourceScopeContext(
            OwnerUserId: recording.OwnerUserId,
            ShopId: recording.ShopId,
            WarehouseId: recording.WarehouseId);

        var canHold = await _scopeAuth.HasPermissionAsync(
            userId,
            PermissionCatalog.VideoHold,
            resourceScope,
            ct);

        if (!canHold)
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "video.hold_updated",
                EntityType: "Recording",
                EntityId: recording.Id.ToString(),
                Outcome: AuditOutcome.Denied,
                ActorUserId: userId,
                ActorEmail: userEmail,
                ShopId: recording.ShopId,
                WarehouseId: recording.WarehouseId,
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new { reason = "MISSING_VIDEO_HOLD_PERMISSION_OR_SCOPE" }), ct);

            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "FORBIDDEN",
                "Bạn không có quyền đánh dấu hoặc gỡ trạng thái giữ lại (Hold) cho video này."));
        }

        var normalizedReason = request.Reason?.Trim();
        if (request.Hold)
        {
            if (string.IsNullOrWhiteSpace(normalizedReason) || normalizedReason.Length < 3)
            {
                return BadRequest(new ApiErrorResponse(
                    "HOLD_REASON_REQUIRED",
                    "Vui lòng nhập lý do giữ lại video (Hold) tối thiểu 3 ký tự (ví dụ: mã khiếu nại/tranh chấp đơn hàng)."));
            }

            if (normalizedReason.Length > 1000)
            {
                return BadRequest(new ApiErrorResponse(
                    "HOLD_REASON_TOO_LONG",
                    "Lý do giữ lại video không được vượt quá 1000 ký tự."));
            }
        }
        else if (normalizedReason is { Length: > 1000 })
        {
            return BadRequest(new ApiErrorResponse(
                "HOLD_REASON_TOO_LONG",
                "Ghi chú gỡ giữ lại không được vượt quá 1000 ký tự."));
        }

        var now = DateTime.UtcNow;
        var previousHold = recording.Hold;

        recording.Hold = request.Hold;
        recording.HoldReason = request.Hold ? normalizedReason : null;
        recording.HoldUpdatedByUserId = userId;
        recording.HoldUpdatedAtUtc = now;
        recording.UpdatedAtUtc = now;

        await _db.SaveChangesAsync(ct);

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "video.hold_updated",
            EntityType: "Recording",
            EntityId: recording.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: userId,
            ActorEmail: userEmail,
            ShopId: recording.ShopId,
            WarehouseId: recording.WarehouseId,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new
            {
                trackingNumber = recording.TrackingNumber,
                previousHold,
                hold = recording.Hold,
                reason = normalizedReason
            }), ct);

        return Ok(new VideoHoldStateDto(
            RecordingId: recording.Id,
            Hold: recording.Hold,
            HoldReason: recording.HoldReason,
            HoldUpdatedByUserId: recording.HoldUpdatedByUserId,
            HoldUpdatedAtUtc: recording.HoldUpdatedAtUtc));
    }

    [HttpPost("{id:guid}/deletion-requests")]
    public async Task<ActionResult<VideoDeletionRequestSummaryDto>> CreateDeletionRequest(
        Guid id,
        [FromBody] CreateDeletionRequestPayload request,
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
                "VIDEO_NOT_FOUND",
                "Không tìm thấy bản ghi video yêu cầu."));
        }

        var resourceScope = new ResourceScopeContext(
            OwnerUserId: recording.OwnerUserId,
            ShopId: recording.ShopId,
            WarehouseId: recording.WarehouseId);

        var canRequestDelete = await _scopeAuth.HasPermissionAsync(
            userId,
            PermissionCatalog.VideoDeleteRequest,
            resourceScope,
            ct);

        if (!canRequestDelete)
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "video.delete_request_created",
                EntityType: "Recording",
                EntityId: recording.Id.ToString(),
                Outcome: AuditOutcome.Denied,
                ActorUserId: userId,
                ActorEmail: userEmail,
                ShopId: recording.ShopId,
                WarehouseId: recording.WarehouseId,
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new { reason = "MISSING_VIDEO_DELETE_REQUEST_PERMISSION_OR_SCOPE" }), ct);

            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "FORBIDDEN",
                "Bạn không có quyền tạo yêu cầu xóa video này."));
        }

        if (recording.Hold)
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "video.delete_request_blocked_hold",
                EntityType: "Recording",
                EntityId: recording.Id.ToString(),
                Outcome: AuditOutcome.Denied,
                ActorUserId: userId,
                ActorEmail: userEmail,
                ShopId: recording.ShopId,
                WarehouseId: recording.WarehouseId,
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new
                {
                    trackingNumber = recording.TrackingNumber,
                    holdReason = recording.HoldReason
                }), ct);

            return Conflict(new ApiErrorResponse(
                "VIDEO_ON_HOLD",
                "Không thể yêu cầu xóa vì video đang ở trạng thái giữ lại (Hold) để bảo vệ bằng chứng khiếu nại."));
        }

        var reason = request.Reason?.Trim() ?? string.Empty;
        if (string.IsNullOrWhiteSpace(reason) || reason.Length < 3)
        {
            return BadRequest(new ApiErrorResponse(
                "DELETE_REASON_REQUIRED",
                "Vui lòng nhập lý do yêu cầu xóa rõ ràng (tối thiểu 3 ký tự)."));
        }

        if (reason.Length > 1000)
        {
            return BadRequest(new ApiErrorResponse(
                "DELETE_REASON_TOO_LONG",
                "Lý do yêu cầu xóa không được vượt quá 1000 ký tự."));
        }

        var hasPending = await _db.DeletionRequests
            .AsNoTracking()
            .AnyAsync(d =>
                d.RecordingId == recording.Id &&
                d.Status == DeletionRequestStatus.Pending, ct);

        if (hasPending)
        {
            return Conflict(new ApiErrorResponse(
                "PENDING_DELETION_REQUEST_EXISTS",
                "Video này đã có một yêu cầu xóa đang chờ phê duyệt."));
        }

        var deletionRequest = new DeletionRequest
        {
            Id = Guid.NewGuid(),
            RecordingId = recording.Id,
            RequestedByUserId = userId,
            Reason = reason,
            Status = DeletionRequestStatus.Pending,
            CreatedAtUtc = DateTime.UtcNow
        };

        _db.DeletionRequests.Add(deletionRequest);
        await _db.SaveChangesAsync(ct);

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "video.delete_request_created",
            EntityType: "Recording",
            EntityId: recording.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: userId,
            ActorEmail: userEmail,
            ShopId: recording.ShopId,
            WarehouseId: recording.WarehouseId,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new
            {
                deletionRequestId = deletionRequest.Id,
                trackingNumber = recording.TrackingNumber,
                reason
            }), ct);

        var requester = await _db.Users
            .AsNoTracking()
            .Where(u => u.Id == userId)
            .Select(u => new { Email = u.Email ?? string.Empty, u.FullName })
            .FirstAsync(ct);

        return StatusCode(StatusCodes.Status201Created, new VideoDeletionRequestSummaryDto(
            Id: deletionRequest.Id,
            RecordingId: deletionRequest.RecordingId,
            RequestedByUserId: deletionRequest.RequestedByUserId,
            RequestedByEmail: requester.Email,
            RequestedByFullName: requester.FullName,
            Reason: deletionRequest.Reason,
            Status: deletionRequest.Status,
            ReviewedByUserId: null,
            ReviewedByEmail: null,
            ReviewedByFullName: null,
            ReviewNote: null,
            CreatedAtUtc: deletionRequest.CreatedAtUtc,
            ReviewedAtUtc: null));
    }

    private async Task<IActionResult> StreamVideoCoreAsync(
        Guid id,
        string? variant,
        CancellationToken ct)
    {
        var userId = HttpContext.GetRequiredUserId();
        var userEmail = HttpContext.GetUserEmail();

        var recording = await _db.Recordings
            .AsNoTracking()
            .Include(r => r.VideoAssets)
            .FirstOrDefaultAsync(r => r.Id == id && !r.IsSoftDeleted, ct);

        if (recording is null)
        {
            return NotFound(new ApiErrorResponse(
                "VIDEO_NOT_FOUND",
                "Không tìm thấy bản ghi video yêu cầu."));
        }

        var resourceScope = new ResourceScopeContext(
            OwnerUserId: recording.OwnerUserId,
            ShopId: recording.ShopId,
            WarehouseId: recording.WarehouseId);

        var canView = await _scopeAuth.HasPermissionAsync(
            userId,
            PermissionCatalog.VideoView,
            resourceScope,
            ct);

        if (!canView)
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "video.stream",
                EntityType: "Recording",
                EntityId: recording.Id.ToString(),
                Outcome: AuditOutcome.Denied,
                ActorUserId: userId,
                ActorEmail: userEmail,
                ShopId: recording.ShopId,
                WarehouseId: recording.WarehouseId,
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new { reason = "OUT_OF_SCOPE_OR_MISSING_VIDEO_VIEW" }), ct);

            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "FORBIDDEN",
                "Bạn không có quyền phát trực tuyến video ngoài phạm vi được cấp."));
        }

        if (recording.StorageStatus != StorageStatus.Stored)
        {
            return Conflict(new ApiErrorResponse(
                "VIDEO_NOT_STORED",
                "Video chưa hoàn tất kiểm tra và lưu trữ nên chưa thể phát trực tuyến."));
        }

        var normalizedVariant = (variant ?? "auto").Trim().ToLowerInvariant();
        if (normalizedVariant is not ("auto" or "preview" or "original"))
        {
            return BadRequest(new ApiErrorResponse(
                "INVALID_STREAM_VARIANT",
                "Tham số variant không hợp lệ. Chỉ chấp nhận: auto, preview, original."));
        }

        var originalAsset = recording.VideoAssets.FirstOrDefault(a => a.Kind == AssetKind.Original);
        var previewAsset = recording.PreviewStatus == PreviewStatus.Ready
            ? recording.VideoAssets.FirstOrDefault(a => a.Kind == AssetKind.Preview)
            : null;

        VideoAsset? selectedAsset = normalizedVariant switch
        {
            "preview" => previewAsset,
            "original" => originalAsset,
            _ => previewAsset ?? originalAsset
        };

        if (normalizedVariant == "preview" && selectedAsset is null)
        {
            return NotFound(new ApiErrorResponse(
                "PREVIEW_ASSET_NOT_AVAILABLE",
                "Bản xem chuyển mã (Preview MP4) chưa sẵn sàng hoặc không cần thiết cho video này."));
        }

        if (selectedAsset is null || string.IsNullOrWhiteSpace(selectedAsset.RelativePath))
        {
            return StatusCode(StatusCodes.Status503ServiceUnavailable, new ApiErrorResponse(
                "STORAGE_FILE_UNAVAILABLE",
                "Tệp video đã lưu hiện không khả dụng trên kho lưu trữ. Hệ thống không tự chuyển sang bản lưu tạm chưa xác minh."));
        }

        // Strictly read through IVideoStorage.OpenReadAsync — NEVER fall back to unverified local staging!
        Stream stream;
        try
        {
            stream = await _videoStorage.OpenReadAsync(selectedAsset.RelativePath, ct);
        }
        catch (Exception ex) when (ex is StorageUnavailableException or IOException or UnauthorizedAccessException)
        {
            return StorageFileUnavailableResult(ex);
        }

        var mimeType = string.IsNullOrWhiteSpace(selectedAsset.MimeType)
            ? "application/octet-stream"
            : selectedAsset.MimeType;

        Response.Headers.CacheControl = "private, no-store";
        Response.Headers["X-Content-Type-Options"] = "nosniff";

        return File(stream, mimeType, enableRangeProcessing: true);
    }

    private ObjectResult StorageFileUnavailableResult(Exception ex)
    {
        var userMessage = ex is StorageUnavailableException sue && !string.IsNullOrWhiteSpace(sue.UserSafeMessage)
            ? sue.UserSafeMessage
            : "Tệp video đã lưu trên kho lưu trữ hiện tạm thời không khả dụng (mất kết nối NAS hoặc sai định danh kho). Hệ thống không sử dụng bản lưu tạm chưa xác minh.";

        return StatusCode(StatusCodes.Status503ServiceUnavailable, new ApiErrorResponse(
            "STORAGE_FILE_UNAVAILABLE",
            userMessage));
    }

    private static string ResolveSafeDownloadExtension(string? actualContainer, string relativePath)
    {
        if (!string.IsNullOrWhiteSpace(actualContainer))
        {
            try
            {
                return StoragePathBuilder.ResolveVerifiedExtension(actualContainer);
            }
            catch (ArgumentException)
            {
                // Fall back to verified relative path extension
            }
        }

        var ext = Path.GetExtension(relativePath);
        return ext.ToLowerInvariant() switch
        {
            ".webm" or ".mp4" or ".mkv" or ".mov" => ext.ToLowerInvariant(),
            _ => ".webm"
        };
    }

    private static string? NormalizeOptionalMime(string? rawMime)
    {
        if (string.IsNullOrWhiteSpace(rawMime))
        {
            return null;
        }

        var trimmed = rawMime.Trim();
        return trimmed.Length > 128 ? trimmed[..128] : trimmed;
    }

    private static string? NormalizeOptionalSha256(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        var trimmed = raw.Trim().ToLowerInvariant();
        return trimmed.Length == 64 && trimmed.All(Uri.IsHexDigit) ? trimmed : null;
    }
}
