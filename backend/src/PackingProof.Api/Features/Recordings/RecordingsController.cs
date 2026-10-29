using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using PackingProof.Api.Common;
using PackingProof.Core.Abstractions;
using PackingProof.Core.Entities;
using PackingProof.Core.Enums;
using PackingProof.Core.Permissions;
using PackingProof.Core.Tracking;
using PackingProof.Infrastructure.Configuration;
using PackingProof.Infrastructure.Persistence;

namespace PackingProof.Api.Features.Recordings;

[ApiController]
[Route("api/recordings")]
[Authorize]
public sealed class RecordingsController : ControllerBase
{
    private readonly PackingProofDbContext _db;
    private readonly ITrackingCodeParser _trackingParser;
    private readonly IScopeAuthorizationService _scopeAuth;
    private readonly IOrderLinkResolver _orderLinkResolver;
    private readonly IAuditLogger _auditLogger;
    private readonly PackingProofOptions _options;

    public RecordingsController(
        PackingProofDbContext db,
        ITrackingCodeParser trackingParser,
        IScopeAuthorizationService scopeAuth,
        IOrderLinkResolver orderLinkResolver,
        IAuditLogger auditLogger,
        PackingProofOptions options)
    {
        _db = db;
        _trackingParser = trackingParser;
        _scopeAuth = scopeAuth;
        _orderLinkResolver = orderLinkResolver;
        _auditLogger = auditLogger;
        _options = options;
    }

    [HttpPost("inspect-code")]
    public async Task<ActionResult<InspectTrackingCodeResponse>> InspectCode(
        [FromBody] InspectTrackingCodeRequest request,
        CancellationToken ct)
    {
        var userId = HttpContext.GetRequiredUserId();

        var warehouse = await LoadActiveWarehouseInShopAsync(request.ShopId, request.WarehouseId, ct);
        if (warehouse is null)
        {
            return BadRequest(new ApiErrorResponse(
                "INVALID_SHOP_WAREHOUSE",
                "Shop hoặc Kho được chọn không tồn tại, đã ngưng hoạt động hoặc không khớp với nhau."));
        }

        var inspectScope = new ResourceScopeContext(
            OwnerUserId: userId,
            ShopId: request.ShopId,
            WarehouseId: request.WarehouseId);

        var canCreate =
            await _scopeAuth.HasPermissionAsync(userId, PermissionCatalog.RecordingCreate, inspectScope, ct) ||
            await _scopeAuth.HasPermissionAsync(userId, PermissionCatalog.VideoImport, inspectScope, ct);

        if (!canCreate)
        {
            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "FORBIDDEN",
                "Tài khoản của bạn không có quyền tạo phiên quay tại Shop/Kho này."));
        }

        var parsed = _trackingParser.Parse(request.RawCode, request.FormatHint);
        if (!parsed.IsValid || string.IsNullOrEmpty(parsed.TrackingNumber))
        {
            return Ok(new InspectTrackingCodeResponse(
                IsValid: false,
                TrackingNumber: null,
                CarrierCode: null,
                TikTokOrderId: null,
                MatchedRule: null,
                ExistingRecordingCount: 0,
                WarningMessage: null,
                ErrorCode: parsed.ErrorCode ?? "INVALID_TRACKING_CODE",
                ErrorMessage: parsed.UserSafeErrorMessage ?? "Mã vận đơn không hợp lệ."));
        }

        var orderResolution = await _orderLinkResolver.ResolveAsync(request.ShopId, parsed.TrackingNumber, ct);
        var carrierCode = parsed.CarrierCode ?? orderResolution?.CarrierCode;
        var tikTokOrderId = parsed.TikTokOrderId ?? orderResolution?.TikTokOrderId;

        var existingCount = await CountExistingRecordingsAsync(request.ShopId, parsed.TrackingNumber, ct);
        var warningMessage = BuildExistingRecordingsWarning(parsed.TrackingNumber, existingCount);

        return Ok(new InspectTrackingCodeResponse(
            IsValid: true,
            TrackingNumber: parsed.TrackingNumber,
            CarrierCode: carrierCode,
            TikTokOrderId: tikTokOrderId,
            MatchedRule: parsed.MatchedRule,
            ExistingRecordingCount: existingCount,
            WarningMessage: warningMessage));
    }

    [HttpPost]
    public async Task<ActionResult<CreateRecordingResponse>> CreateRecording(
        [FromBody] CreateRecordingRequest request,
        CancellationToken ct)
    {
        var userId = HttpContext.GetRequiredUserId();
        var userEmail = HttpContext.GetUserEmail();

        var warehouse = await LoadActiveWarehouseInShopAsync(request.ShopId, request.WarehouseId, ct);
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

        var resourceContext = new ResourceScopeContext(
            OwnerUserId: userId,
            ShopId: request.ShopId,
            WarehouseId: request.WarehouseId);

        var canCreate = await _scopeAuth.HasPermissionAsync(
            userId,
            PermissionCatalog.RecordingCreate,
            resourceContext,
            ct);

        if (!canCreate)
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "recording.create",
                EntityType: "Recording",
                Outcome: AuditOutcome.Denied,
                ActorUserId: userId,
                ActorEmail: userEmail,
                ShopId: request.ShopId,
                WarehouseId: request.WarehouseId,
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new { reason = "MISSING_RECORDING_CREATE_SCOPE" }), ct);

            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "FORBIDDEN",
                "Tài khoản của bạn không có quyền tạo phiên quay tại Shop/Kho này."));
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
                    Metadata: new { reason = "MISSING_MANUAL_CODE_PERMISSION" }), ct);

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

        var effectiveFormatHint = isManual ? BarcodeFormatHint.ManualEntry : request.FormatHint;
        var parsed = _trackingParser.Parse(request.RawCode, effectiveFormatHint);
        if (!parsed.IsValid || string.IsNullOrEmpty(parsed.TrackingNumber))
        {
            return BadRequest(new ApiErrorResponse(
                parsed.ErrorCode ?? "INVALID_TRACKING_CODE",
                parsed.UserSafeErrorMessage ?? "Mã vận đơn không hợp lệ. Vui lòng quét lại mã trên tem đơn hàng."));
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
                    "Phiên quay trước cần liên kết không tồn tại hoặc không thuộc cùng Shop."));
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
                    "Bạn không có quyền liên kết tới phiên quay gốc này."));
            }

            previousLinkedTrackingNumber = linkedRecording.TrackingNumber;
        }

        var safeSegment = PathSegmentSanitizer.ToSafeSegment(parsed.TrackingNumber);
        var orderResolution = await _orderLinkResolver.ResolveAsync(request.ShopId, parsed.TrackingNumber, ct);
        var carrierCode = parsed.CarrierCode ?? orderResolution?.CarrierCode;
        var tikTokOrderId = parsed.TikTokOrderId ?? orderResolution?.TikTokOrderId;

        var existingCount = await CountExistingRecordingsAsync(request.ShopId, parsed.TrackingNumber, ct);
        var warningMessage = BuildExistingRecordingsWarning(parsed.TrackingNumber, existingCount);

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
            Source = RecordingSource.RecordedInBrowser,
            ManualEntryReason = normalizedManualReason,
            LinkedFromRecordingId = request.LinkedFromRecordingId,
            CaptureStatus = CaptureStatus.Created,
            StorageStatus = StorageStatus.AwaitingUpload,
            PreviewStatus = PreviewStatus.NotRequired,
            ClientMimeType = NormalizeOptionalMime(request.ClientMimeType),
            CreatedAtUtc = now,
            UpdatedAtUtc = now
        };

        _db.Recordings.Add(recording);
        await _db.SaveChangesAsync(ct);

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
                    manualEntryReason = recording.ManualEntryReason
                }), ct);
        }

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "recording.created",
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
                carrierCode = recording.CarrierCode,
                tikTokOrderId = recording.TikTokOrderId,
                matchedRule = parsed.MatchedRule,
                isManualEntry = isManual,
                linkedFromRecordingId = recording.LinkedFromRecordingId,
                previousLinkedTrackingNumber,
                existingRecordingCount = existingCount
            }), ct);

        var owner = await _db.Users
            .AsNoTracking()
            .Where(u => u.Id == userId)
            .Select(u => new { Email = u.Email ?? string.Empty, u.FullName })
            .FirstAsync(ct);

        var limits = await GetActiveLimitsAsync(ct);
        var dto = MapRecordingDto(
            recording,
            owner.Email,
            owner.FullName,
            warehouse.Shop.Name,
            warehouse.Name,
            _options.StorageMode);

        return CreatedAtAction(
            nameof(GetRecordingById),
            new { id = recording.Id },
            new CreateRecordingResponse(
                Recording: dto,
                ExistingRecordingCount: existingCount,
                WarningMessage: warningMessage,
                Limits: limits));
    }

    [HttpPost("{id:guid}/events")]
    public async Task<ActionResult<RecordingDto>> PostRecordingEvent(
        Guid id,
        [FromBody] RecordingEventRequest request,
        CancellationToken ct)
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

        // Only the recording owner with valid recording.create permission in scope can drive capture lifecycle events.
        var hasScopeCreate = recording.OwnerUserId == userId &&
            await _scopeAuth.HasPermissionAsync(
                userId,
                PermissionCatalog.RecordingCreate,
                new ResourceScopeContext(
                    OwnerUserId: recording.OwnerUserId,
                    ShopId: recording.ShopId,
                    WarehouseId: recording.WarehouseId),
                ct);

        if (!hasScopeCreate)
        {
            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "FORBIDDEN",
                "Chỉ người tạo phiên quay hợp lệ trong phạm vi được phép mới có thể cập nhật trạng thái quay."));
        }

        if (request.TrackingNumber is not null)
        {
            return Conflict(new ApiErrorResponse(
                "TRACKING_NUMBER_IMMUTABLE",
                "Mã vận đơn của phiên quay đã khóa bất biến, không được phép chỉnh sửa. Nếu nhầm mã, vui lòng tạo phiên quay mới liên kết phiên cũ."));
        }

        if (request.StorageStatus is not null)
        {
            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "CLIENT_STORAGE_STATUS_FORBIDDEN",
                "Trạng thái lưu trữ (StorageStatus) chỉ do máy chủ xác minh, trình duyệt không được phép tự đặt."));
        }

        var normalizedEvent = request.EventType?.Trim().ToLowerInvariant() ?? string.Empty;
        if (normalizedEvent == "stored")
        {
            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "CLIENT_STORAGE_STATUS_FORBIDDEN",
                "Trình duyệt không được phép tự đánh dấu trạng thái đã lưu trữ (Stored)."));
        }

        var now = DateTime.UtcNow;
        var previousStatus = recording.CaptureStatus;

        switch (normalizedEvent)
        {
            case "started":
                if (recording.CaptureStatus != CaptureStatus.Created)
                {
                    return ConflictTransition(recording.CaptureStatus, normalizedEvent);
                }

                recording.CaptureStatus = CaptureStatus.Recording;
                recording.StartedAtUtc = now;
                if (!string.IsNullOrWhiteSpace(request.ClientMimeType))
                {
                    recording.ClientMimeType = NormalizeOptionalMime(request.ClientMimeType);
                }
                recording.UpdatedAtUtc = now;
                break;

            case "captured":
                if (recording.CaptureStatus != CaptureStatus.Recording ||
                    recording.StorageStatus == StorageStatus.Stored)
                {
                    return ConflictTransition(recording.CaptureStatus, normalizedEvent);
                }

                recording.CaptureStatus = CaptureStatus.Captured;
                recording.EndedAtUtc = now;
                recording.DurationSeconds = NormalizeDurationSeconds(request.DurationSeconds);
                recording.UpdatedAtUtc = now;
                break;

            case "interrupted":
                if (recording.CaptureStatus != CaptureStatus.Created &&
                    recording.CaptureStatus != CaptureStatus.Recording)
                {
                    return ConflictTransition(recording.CaptureStatus, normalizedEvent);
                }

                recording.CaptureStatus = CaptureStatus.Interrupted;
                recording.EndedAtUtc = now;
                recording.DurationSeconds = NormalizeDurationSeconds(request.DurationSeconds);
                recording.LastErrorCode = NormalizeErrorCode(request.ErrorCode) ?? "CLIENT_CAPTURE_INTERRUPTED";
                recording.UserSafeErrorMessage = NormalizeSafeMessage(request.Reason) ??
                    "Phiên quay bị gián đoạn trước khi kết thúc bình thường.";
                recording.UpdatedAtUtc = now;
                break;

            case "cancelled":
                if (recording.CaptureStatus != CaptureStatus.Created ||
                    recording.StorageStatus == StorageStatus.Stored)
                {
                    return ConflictTransition(recording.CaptureStatus, normalizedEvent);
                }

                recording.CaptureStatus = CaptureStatus.Cancelled;
                recording.EndedAtUtc = now;
                if (!string.IsNullOrWhiteSpace(request.Reason))
                {
                    recording.UserSafeErrorMessage = NormalizeSafeMessage(request.Reason);
                }
                recording.UpdatedAtUtc = now;
                break;

            default:
                return BadRequest(new ApiErrorResponse(
                    "INVALID_RECORDING_EVENT",
                    "Loại sự kiện phiên quay không hợp lệ. Chỉ chấp nhận: started, captured, interrupted, cancelled."));
        }

        try
        {
            await _db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            return Conflict(new ApiErrorResponse(
                "CONCURRENCY_CONFLICT",
                "Phiên quay vừa được cập nhật đồng thời. Vui lòng kiểm tra lại trạng thái hiện tại."));
        }

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: $"recording.{normalizedEvent}",
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
                previousCaptureStatus = previousStatus.ToString(),
                newCaptureStatus = recording.CaptureStatus.ToString(),
                durationSeconds = recording.DurationSeconds,
                errorCode = recording.LastErrorCode
            }), ct);

        return Ok(MapRecordingDto(
            recording,
            recording.OwnerUser.Email ?? string.Empty,
            recording.OwnerUser.FullName,
            recording.Shop.Name,
            recording.Warehouse.Name,
            _options.StorageMode));
    }

    [HttpGet("{id:guid}")]
    public async Task<ActionResult<RecordingDto>> GetRecordingById(Guid id, CancellationToken ct)
    {
        var userId = HttpContext.GetRequiredUserId();

        var recording = await _db.Recordings
            .AsNoTracking()
            .Include(r => r.OwnerUser)
            .Include(r => r.Shop)
            .Include(r => r.Warehouse)
            .FirstOrDefaultAsync(r => r.Id == id && !r.IsSoftDeleted, ct);

        if (recording is null)
        {
            return NotFound(new ApiErrorResponse(
                "RECORDING_NOT_FOUND",
                "Không tìm thấy bản ghi phiên quay."));
        }

        var resourceContext = new ResourceScopeContext(
            OwnerUserId: recording.OwnerUserId,
            ShopId: recording.ShopId,
            WarehouseId: recording.WarehouseId);

        var canView = await _scopeAuth.HasPermissionAsync(userId, PermissionCatalog.VideoView, resourceContext, ct) ||
            (recording.OwnerUserId == userId &&
             await _scopeAuth.HasPermissionAsync(userId, PermissionCatalog.RecordingCreate, resourceContext, ct)) ||
            (recording.OwnerUserId == userId &&
             recording.Source == RecordingSource.Imported &&
             await _scopeAuth.HasPermissionAsync(userId, PermissionCatalog.VideoImport, resourceContext, ct));

        if (!canView)
        {
            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "FORBIDDEN",
                "Bạn không có quyền xem bản ghi phiên quay ngoài phạm vi được cấp."));
        }

        return Ok(MapRecordingDto(
            recording,
            recording.OwnerUser.Email ?? string.Empty,
            recording.OwnerUser.FullName,
            recording.Shop.Name,
            recording.Warehouse.Name,
            _options.StorageMode));
    }

    [HttpGet]
    public async Task<ActionResult<PagedRecordingsResponse>> ListRecordings(
        [FromQuery] Guid? shopId = null,
        [FromQuery] Guid? warehouseId = null,
        [FromQuery] string? trackingNumber = null,
        [FromQuery] CaptureStatus? captureStatus = null,
        [FromQuery] StorageStatus? storageStatus = null,
        [FromQuery] bool mineOnly = false,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        CancellationToken ct = default)
    {
        var userId = HttpContext.GetRequiredUserId();
        var access = await _scopeAuth.GetEffectiveAccessAsync(userId, ct);

        if (!access.IsActive)
        {
            return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                "FORBIDDEN",
                "Tài khoản không ở trạng thái hoạt động."));
        }

        var normalizedPage = Math.Max(1, page);
        var normalizedPageSize = Math.Clamp(pageSize, 1, 100);

        IQueryable<Recording> query = _db.Recordings
            .AsNoTracking()
            .Where(r => !r.IsSoftDeleted);

        var hasAllViewScope = access.IsSuperAdmin &&
            access.Grants.Any(g =>
                g.ScopeType == ScopeType.All &&
                g.Permissions.Contains(PermissionCatalog.VideoView, StringComparer.Ordinal));

        if (!hasAllViewScope)
        {
            var viewShopIds = new HashSet<Guid>();
            var viewWarehouseIds = new HashSet<Guid>();
            var ownShopIds = new HashSet<Guid>();
            var ownWarehouseIds = new HashSet<Guid>();
            var hasUnrestrictedOwn = false;

            foreach (var grant in access.Grants)
            {
                var hasView = grant.Permissions.Contains(PermissionCatalog.VideoView, StringComparer.Ordinal);
                var hasOwnCreate = grant.Permissions.Contains(PermissionCatalog.RecordingCreate, StringComparer.Ordinal);

                if (!hasView && !hasOwnCreate)
                {
                    continue;
                }

                if (hasView)
                {
                    switch (grant.ScopeType)
                    {
                        case ScopeType.Shop when grant.ShopId.HasValue:
                            viewShopIds.Add(grant.ShopId.Value);
                            break;

                        case ScopeType.Warehouse when grant.WarehouseId.HasValue:
                            viewWarehouseIds.Add(grant.WarehouseId.Value);
                            break;

                        case ScopeType.Own:
                            if (grant.WarehouseId.HasValue)
                            {
                                ownWarehouseIds.Add(grant.WarehouseId.Value);
                            }
                            else if (grant.ShopId.HasValue)
                            {
                                ownShopIds.Add(grant.ShopId.Value);
                            }
                            else
                            {
                                hasUnrestrictedOwn = true;
                            }
                            break;
                    }
                }
                else if (hasOwnCreate)
                {
                    // recording.create without video.view only authorizes reading own created sessions within that scope
                    if (grant.WarehouseId.HasValue)
                    {
                        ownWarehouseIds.Add(grant.WarehouseId.Value);
                    }
                    else if (grant.ShopId.HasValue)
                    {
                        ownShopIds.Add(grant.ShopId.Value);
                    }
                    else if (grant.ScopeType == ScopeType.Own ||
                             (grant.ScopeType == ScopeType.All && access.IsSuperAdmin))
                    {
                        hasUnrestrictedOwn = true;
                    }
                }
            }

            if (viewShopIds.Count == 0 &&
                viewWarehouseIds.Count == 0 &&
                ownShopIds.Count == 0 &&
                ownWarehouseIds.Count == 0 &&
                !hasUnrestrictedOwn)
            {
                return StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
                    "FORBIDDEN",
                    "Tài khoản của bạn không có quyền xem danh sách phiên quay."));
            }

            var viewShopList = viewShopIds.ToList();
            var viewWhList = viewWarehouseIds.ToList();
            var ownShopList = ownShopIds.ToList();
            var ownWhList = ownWarehouseIds.ToList();

            query = query.Where(r =>
                viewShopList.Contains(r.ShopId) ||
                viewWhList.Contains(r.WarehouseId) ||
                (hasUnrestrictedOwn && r.OwnerUserId == userId) ||
                (r.OwnerUserId == userId && ownShopList.Contains(r.ShopId)) ||
                (r.OwnerUserId == userId && ownWhList.Contains(r.WarehouseId)));
        }

        if (mineOnly)
        {
            query = query.Where(r => r.OwnerUserId == userId);
        }

        if (shopId.HasValue)
        {
            query = query.Where(r => r.ShopId == shopId.Value);
        }

        if (warehouseId.HasValue)
        {
            query = query.Where(r => r.WarehouseId == warehouseId.Value);
        }

        if (!string.IsNullOrWhiteSpace(trackingNumber))
        {
            var term = trackingNumber.Trim();
            query = query.Where(r => r.TrackingNumber.Contains(term));
        }

        if (captureStatus.HasValue)
        {
            query = query.Where(r => r.CaptureStatus == captureStatus.Value);
        }

        if (storageStatus.HasValue)
        {
            query = query.Where(r => r.StorageStatus == storageStatus.Value);
        }

        var totalCount = await query.CountAsync(ct);
        var totalPages = totalCount == 0
            ? 0
            : (int)Math.Ceiling(totalCount / (double)normalizedPageSize);

        var currentStorageMode = _options.StorageMode;
        var items = await query
            .OrderByDescending(r => r.CreatedAtUtc)
            .ThenByDescending(r => r.Id)
            .Skip((normalizedPage - 1) * normalizedPageSize)
            .Take(normalizedPageSize)
            .Select(r => new RecordingDto(
                r.Id,
                r.OwnerUserId,
                r.OwnerUser.Email ?? string.Empty,
                r.OwnerUser.FullName,
                r.ShopId,
                r.Shop.Name,
                r.WarehouseId,
                r.Warehouse.Name,
                r.PackingStationId,
                r.TrackingNumber,
                r.SafeTrackingSegment,
                r.CarrierCode,
                r.TikTokOrderId,
                r.Source,
                r.ManualEntryReason,
                r.LinkedFromRecordingId,
                r.CaptureStatus,
                r.StorageStatus,
                r.PreviewStatus,
                r.ClientMimeType,
                r.DurationSeconds,
                r.StartedAtUtc,
                r.EndedAtUtc,
                r.StoredAtUtc,
                r.Hold,
                r.LastErrorCode,
                r.UserSafeErrorMessage,
                r.CreatedAtUtc,
                r.UpdatedAtUtc,
                r.IsRetryable,
                r.ServerReceivedAtUtc,
                r.ActualContainer,
                r.VideoCodec,
                currentStorageMode))
            .ToListAsync(ct);

        return Ok(new PagedRecordingsResponse(
            Items: items,
            Page: normalizedPage,
            PageSize: normalizedPageSize,
            TotalCount: totalCount,
            TotalPages: totalPages));
    }

    private ActionResult<RecordingDto> ConflictTransition(CaptureStatus currentStatus, string eventType) =>
        Conflict(new ApiErrorResponse(
            "INVALID_CAPTURE_TRANSITION",
            $"Không thể thực hiện chuyển trạng thái '{eventType}' khi phiên quay đang ở trạng thái '{currentStatus}'."));

    private async Task<Warehouse?> LoadActiveWarehouseInShopAsync(
        Guid shopId,
        Guid warehouseId,
        CancellationToken ct)
    {
        if (shopId == Guid.Empty || warehouseId == Guid.Empty)
        {
            return null;
        }

        return await _db.Warehouses
            .AsNoTracking()
            .Include(w => w.Shop)
            .FirstOrDefaultAsync(w =>
                w.Id == warehouseId &&
                w.ShopId == shopId &&
                w.IsActive &&
                w.Shop.IsActive, ct);
    }

    private Task<int> CountExistingRecordingsAsync(
        Guid shopId,
        string trackingNumber,
        CancellationToken ct) =>
        _db.Recordings
            .AsNoTracking()
            .CountAsync(r =>
                r.ShopId == shopId &&
                r.TrackingNumber == trackingNumber &&
                !r.IsSoftDeleted &&
                r.CaptureStatus != CaptureStatus.Cancelled, ct);

    private static string? BuildExistingRecordingsWarning(string trackingNumber, int existingCount) =>
        existingCount > 0
            ? $"Mã vận đơn {trackingNumber} đã có {existingCount} phiên quay trước đó tại shop này. Hệ thống sẽ tạo phiên quay mới độc lập và không ghi đè video cũ."
            : null;

    private async Task<RecordingRuntimeLimitsDto> GetActiveLimitsAsync(CancellationToken ct)
    {
        var profile = await _db.StorageProfiles
            .AsNoTracking()
            .OrderBy(p => p.Name)
            .FirstOrDefaultAsync(ct);

        if (profile is null)
        {
            return new RecordingRuntimeLimitsDto(
                MaxRecordingSeconds: _options.MaxRecordingSeconds,
                MaxUploadBytes: _options.MaxUploadBytes,
                MaxLocalPendingRecordings: _options.MaxLocalPendingRecordings,
                EnableAudioRecording: _options.EnableAudioRecording);
        }

        return new RecordingRuntimeLimitsDto(
            MaxRecordingSeconds: profile.MaxRecordingSeconds,
            MaxUploadBytes: profile.MaxUploadBytes,
            MaxLocalPendingRecordings: profile.MaxLocalPendingRecordings,
            EnableAudioRecording: profile.EnableAudioRecording);
    }

    private static string? NormalizeOptionalMime(string? mime)
    {
        if (string.IsNullOrWhiteSpace(mime))
        {
            return null;
        }

        var trimmed = mime.Trim();
        return trimmed.Length <= 128 ? trimmed : trimmed[..128];
    }

    private static double? NormalizeDurationSeconds(double? duration)
    {
        if (!duration.HasValue || double.IsNaN(duration.Value) || double.IsInfinity(duration.Value))
        {
            return null;
        }

        return Math.Clamp(duration.Value, 0, 86_400);
    }

    private static string? NormalizeErrorCode(string? code)
    {
        if (string.IsNullOrWhiteSpace(code))
        {
            return null;
        }

        var trimmed = code.Trim();
        return trimmed.Length <= 64 ? trimmed : trimmed[..64];
    }

    private static string? NormalizeSafeMessage(string? message)
    {
        if (string.IsNullOrWhiteSpace(message))
        {
            return null;
        }

        var trimmed = message.Trim();
        return trimmed.Length <= 500 ? trimmed : trimmed[..500];
    }

    public static RecordingDto MapRecordingDto(
        Recording r,
        string ownerEmail,
        string ownerFullName,
        string shopName,
        string warehouseName,
        StorageMode? storageMode = null) =>
        new(
            Id: r.Id,
            OwnerUserId: r.OwnerUserId,
            OwnerEmail: ownerEmail,
            OwnerFullName: ownerFullName,
            ShopId: r.ShopId,
            ShopName: shopName,
            WarehouseId: r.WarehouseId,
            WarehouseName: warehouseName,
            PackingStationId: r.PackingStationId,
            TrackingNumber: r.TrackingNumber,
            SafeTrackingSegment: r.SafeTrackingSegment,
            CarrierCode: r.CarrierCode,
            TikTokOrderId: r.TikTokOrderId,
            Source: r.Source,
            ManualEntryReason: r.ManualEntryReason,
            LinkedFromRecordingId: r.LinkedFromRecordingId,
            CaptureStatus: r.CaptureStatus,
            StorageStatus: r.StorageStatus,
            PreviewStatus: r.PreviewStatus,
            ClientMimeType: r.ClientMimeType,
            DurationSeconds: r.DurationSeconds,
            StartedAtUtc: r.StartedAtUtc,
            EndedAtUtc: r.EndedAtUtc,
            StoredAtUtc: r.StoredAtUtc,
            Hold: r.Hold,
            LastErrorCode: r.LastErrorCode,
            UserSafeErrorMessage: r.UserSafeErrorMessage,
            CreatedAtUtc: r.CreatedAtUtc,
            UpdatedAtUtc: r.UpdatedAtUtc,
            IsRetryable: r.IsRetryable,
            ServerReceivedAtUtc: r.ServerReceivedAtUtc,
            ActualContainer: r.ActualContainer,
            VideoCodec: r.VideoCodec,
            StorageMode: storageMode);
}

