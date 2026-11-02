using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using PackingProof.Api.Common;
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

namespace PackingProof.Api.Features.Admin;

[ApiController]
[Route("api/admin")]
[Authorize]
public sealed partial class AdminStorageController : ControllerBase
{
    private const long LowFreeSpaceFloorBytes = 2L * 1024 * 1024 * 1024; // 2 GiB

    private readonly PackingProofDbContext _db;
    private readonly IScopeAuthorizationService _scopeAuth;
    private readonly IVideoStorage _videoStorage;
    private readonly StagingQuotaGuard _stagingQuotaGuard;
    private readonly IAuditLogger _auditLogger;
    private readonly PackingProofOptions _options;

    public AdminStorageController(
        PackingProofDbContext db,
        IScopeAuthorizationService scopeAuth,
        IVideoStorage videoStorage,
        StagingQuotaGuard stagingQuotaGuard,
        IAuditLogger auditLogger,
        PackingProofOptions options)
    {
        _db = db;
        _scopeAuth = scopeAuth;
        _videoStorage = videoStorage;
        _stagingQuotaGuard = stagingQuotaGuard;
        _auditLogger = auditLogger;
        _options = options;
    }

    [HttpGet("storage")]
    public async Task<ActionResult<AdminStorageOverviewDto>> GetStorageOverview(CancellationToken ct)
    {
        var actorId = HttpContext.GetRequiredUserId();
        if (!await EnsureStorageManagePermissionAsync(actorId, "admin.storage.view", ct))
        {
            return ForbiddenStorageManage();
        }

        var profile = await LoadOrCreateActiveStorageProfileAsync(ct);
        var overview = await BuildStorageOverviewAsync(profile, ct);
        return Ok(overview);
    }

    [HttpPost("storage/health-check")]
    public async Task<ActionResult<StorageHealthCheckResponseDto>> RunStorageHealthCheck(CancellationToken ct)
    {
        var actorId = HttpContext.GetRequiredUserId();
        if (!await EnsureStorageManagePermissionAsync(actorId, "admin.storage.health_check", ct))
        {
            return ForbiddenStorageManage();
        }

        var report = await _videoStorage.CheckHealthAsync(ct);
        var profile = await LoadOrCreateActiveStorageProfileAsync(ct);

        var (freeBytes, totalBytes, isLowSpace, capacityWarning) = InspectStorageCapacityBestEffort(
            report.RootExists,
            profile.MaxUploadBytes);

        var statusMessage = BuildVietnameseHealthStatusMessage(report);

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "admin.storage.health_check",
            EntityType: "StorageProfile",
            EntityId: profile.Id.ToString(),
            Outcome: report.IsHealthy ? AuditOutcome.Success : AuditOutcome.Failed,
            ActorUserId: actorId,
            ActorEmail: HttpContext.GetUserEmail(),
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new
            {
                mode = report.Mode.ToString(),
                report.IsHealthy,
                report.RootExists,
                report.MarkerValid,
                report.CanReadWrite,
                report.ErrorCode,
                isLowSpaceWarning = isLowSpace
            }), ct);

        return Ok(new StorageHealthCheckResponseDto(
            Mode: report.Mode,
            IsHealthy: report.IsHealthy,
            RootExists: report.RootExists,
            MarkerValid: report.MarkerValid,
            CanReadWrite: report.CanReadWrite,
            AvailableFreeBytes: freeBytes,
            TotalCapacityBytes: totalBytes,
            IsLowSpaceWarning: isLowSpace,
            CapacityWarningMessage: capacityWarning,
            ErrorCode: report.ErrorCode,
            StatusMessage: statusMessage,
            CheckedAtUtc: report.CheckedAtUtc));
    }

    [HttpPut("storage")]
    public async Task<ActionResult<AdminStorageOverviewDto>> UpdateStorageSettings(
        [FromBody] UpdateAdminStorageRequest request,
        CancellationToken ct)
    {
        var actorId = HttpContext.GetRequiredUserId();
        var actorEmail = HttpContext.GetUserEmail();

        if (!await EnsureStorageManagePermissionAsync(actorId, "admin.storage.update", ct))
        {
            return ForbiddenStorageManage();
        }

        if (request.MaxRecordingSeconds is < 10 or > 7200)
        {
            return BadRequest(new ApiErrorResponse(
                "INVALID_MAX_RECORDING_SECONDS",
                "Thời lượng quay tối đa mỗi phiên phải nằm trong khoảng từ 10 đến 7200 giây."));
        }

        if (request.MaxUploadBytes is < 1_048_576 or > 10_737_418_240)
        {
            return BadRequest(new ApiErrorResponse(
                "INVALID_MAX_UPLOAD_BYTES",
                "Giới hạn dung lượng tệp tải lên phải nằm trong khoảng từ 1 MiB đến 10 GiB."));
        }

        if (request.MaxLocalPendingRecordings is < 1 or > 20)
        {
            return BadRequest(new ApiErrorResponse(
                "INVALID_MAX_LOCAL_PENDING",
                "Số bản ghi chờ tối đa trên thiết bị phải nằm trong khoảng từ 1 đến 20."));
        }

        if (request.RetentionDays is < 1 or > 3650)
        {
            return BadRequest(new ApiErrorResponse(
                "INVALID_RETENTION_DAYS",
                "Số ngày lưu giữ tự động (RetentionDays) phải nằm trong khoảng từ 1 đến 3650 ngày."));
        }

        var profile = await LoadOrCreateActiveStorageProfileAsync(ct);

        // Mandatory confirmation whenever retention is turned ON (or shortened while enabled)
        var requiresRetentionConfirmation =
            request.RetentionEnabled &&
            (!profile.RetentionEnabled || request.RetentionDays < profile.RetentionDays);

        if (requiresRetentionConfirmation && !request.ConfirmRetentionEnable)
        {
            await _auditLogger.AppendAsync(new AuditEntryRequest(
                Action: "admin.storage.update",
                EntityType: "StorageProfile",
                EntityId: profile.Id.ToString(),
                Outcome: AuditOutcome.Denied,
                ActorUserId: actorId,
                ActorEmail: actorEmail,
                IpAddress: HttpContext.GetClientIp(),
                UserAgent: HttpContext.GetUserAgent(),
                Metadata: new
                {
                    errorCode = "RETENTION_CONFIRMATION_REQUIRED",
                    requestedRetentionEnabled = request.RetentionEnabled,
                    requestedRetentionDays = request.RetentionDays
                }), ct);

            return BadRequest(new ApiErrorResponse(
                "RETENTION_CONFIRMATION_REQUIRED",
                "Cần xác nhận rõ ràng (confirmRetentionEnable = true) trước khi bật chế độ tự động xóa video theo thời hạn lưu giữ."));
        }

        var shops = await _db.Shops
            .OrderBy(s => s.Name)
            .ToListAsync(ct);

        if (request.ShopSubdirectories is { Count: > 0 })
        {
            var shopsById = shops.ToDictionary(s => s.Id);
            foreach (var update in request.ShopSubdirectories)
            {
                if (!shopsById.TryGetValue(update.ShopId, out var shop))
                {
                    return NotFound(new ApiErrorResponse(
                        "SHOP_NOT_FOUND",
                        "Không tìm thấy Shop cần cập nhật thư mục lưu trữ."));
                }

                if (!TryValidateAndSanitizeSubdirectory(update.AllowedStorageSubdir, out var sanitizedSubdir, out var subdirError))
                {
                    return BadRequest(new ApiErrorResponse(
                        "INVALID_STORAGE_SUBDIR",
                        subdirError!));
                }

                shop.AllowedStorageSubdir = sanitizedSubdir;
            }
        }

        var duplicateSubdir = shops
            .GroupBy(s => s.AllowedStorageSubdir, StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault(g => g.Count() > 1);

        if (duplicateSubdir is not null)
        {
            return Conflict(new ApiErrorResponse(
                "DUPLICATE_STORAGE_SUBDIR",
                $"Thư mục con lưu trữ '{duplicateSubdir.Key}' đang bị trùng giữa nhiều Shop. Mỗi Shop phải có một thư mục con riêng biệt."));
        }

        var previousRetentionEnabled = profile.RetentionEnabled;
        var previousRetentionDays = profile.RetentionDays;

        profile.MaxRecordingSeconds = request.MaxRecordingSeconds;
        profile.MaxUploadBytes = request.MaxUploadBytes;
        profile.MaxLocalPendingRecordings = request.MaxLocalPendingRecordings;
        profile.EnableAudioRecording = request.EnableAudioRecording;
        profile.RetentionEnabled = request.RetentionEnabled;
        profile.RetentionDays = request.RetentionDays;
        profile.AllowedSubdirectoriesJson = JsonSerializer.Serialize(
            shops.Where(s => s.IsActive)
                 .Select(s => s.AllowedStorageSubdir)
                 .Distinct(StringComparer.OrdinalIgnoreCase)
                 .OrderBy(s => s, StringComparer.OrdinalIgnoreCase)
                 .ToArray());
        profile.UpdatedAtUtc = DateTime.UtcNow;
        profile.UpdatedByUserId = actorId;

        await _db.SaveChangesAsync(ct);

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "admin.storage.update",
            EntityType: "StorageProfile",
            EntityId: profile.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: actorId,
            ActorEmail: actorEmail,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new
            {
                profile.MaxRecordingSeconds,
                profile.MaxUploadBytes,
                profile.MaxLocalPendingRecordings,
                profile.EnableAudioRecording,
                previousRetentionEnabled,
                profile.RetentionEnabled,
                previousRetentionDays,
                profile.RetentionDays,
                confirmRetentionEnable = request.ConfirmRetentionEnable,
                shopSubdirectories = shops.Select(s => new { s.Code, s.AllowedStorageSubdir })
            }), ct);

        return Ok(await BuildStorageOverviewAsync(profile, ct));
    }

    [HttpPost("shops")]
    public async Task<ActionResult<AdminShopStorageDto>> CreateShop(
        [FromBody] CreateAdminShopRequest request,
        CancellationToken ct)
    {
        var actorId = HttpContext.GetRequiredUserId();
        var actorEmail = HttpContext.GetUserEmail();

        if (!await EnsureStorageManagePermissionAsync(actorId, "admin.shop.create", ct))
        {
            return ForbiddenStorageManage();
        }

        var code = request.Code?.Trim() ?? string.Empty;
        var name = request.Name?.Trim() ?? string.Empty;

        if (string.IsNullOrWhiteSpace(code) || code.Length > 32 || !SafeOrgCodeRegex().IsMatch(code))
        {
            return BadRequest(new ApiErrorResponse(
                "INVALID_SHOP_CODE",
                "Mã Shop bắt buộc (tối đa 32 ký tự, chỉ gồm chữ không dấu, số, '-' hoặc '_')."));
        }

        if (string.IsNullOrWhiteSpace(name) || name.Length > 128)
        {
            return BadRequest(new ApiErrorResponse(
                "INVALID_SHOP_NAME",
                "Tên Shop bắt buộc và không vượt quá 128 ký tự."));
        }

        var rawSlug = string.IsNullOrWhiteSpace(request.Slug)
            ? code.ToLowerInvariant()
            : request.Slug.Trim().ToLowerInvariant();

        if (!TryValidateAndSanitizeSubdirectory(rawSlug, out var safeSlug, out var slugError))
        {
            return BadRequest(new ApiErrorResponse("INVALID_SHOP_SLUG", slugError!));
        }

        var rawSubdir = string.IsNullOrWhiteSpace(request.AllowedStorageSubdir)
            ? safeSlug
            : request.AllowedStorageSubdir.Trim();

        if (!TryValidateAndSanitizeSubdirectory(rawSubdir, out var safeSubdir, out var subdirError))
        {
            return BadRequest(new ApiErrorResponse("INVALID_STORAGE_SUBDIR", subdirError!));
        }

        var existsDuplicate = await _db.Shops
            .AsNoTracking()
            .AnyAsync(s =>
                s.Code.ToLower() == code.ToLower() ||
                s.Slug.ToLower() == safeSlug.ToLower() ||
                s.AllowedStorageSubdir.ToLower() == safeSubdir.ToLower(), ct);

        if (existsDuplicate)
        {
            return Conflict(new ApiErrorResponse(
                "DUPLICATE_SHOP",
                "Mã Shop, Slug hoặc thư mục con lưu trữ đã tồn tại trong hệ thống."));
        }

        var now = DateTime.UtcNow;
        var shop = new Shop
        {
            Id = Guid.NewGuid(),
            Code = code,
            Slug = safeSlug,
            Name = name,
            AllowedStorageSubdir = safeSubdir,
            IsActive = true,
            CreatedAtUtc = now
        };

        _db.Shops.Add(shop);

        var createdWarehouses = new List<AdminWarehouseStorageDto>();
        if (request.CreateDefaultWarehouse)
        {
            var shortCode = new string(code.Where(char.IsLetterOrDigit).Take(8).ToArray()).ToUpperInvariant();
            if (string.IsNullOrEmpty(shortCode))
            {
                shortCode = "SHOP";
            }

            var defaultWhCode = $"WH-{shortCode}-01";
            var defaultWhName = string.IsNullOrWhiteSpace(request.DefaultWarehouseName)
                ? "Kho chính 01"
                : request.DefaultWarehouseName.Trim();

            var defaultWh = new Warehouse
            {
                Id = Guid.NewGuid(),
                ShopId = shop.Id,
                Code = defaultWhCode,
                Name = defaultWhName,
                IsActive = true,
                CreatedAtUtc = now
            };
            _db.Warehouses.Add(defaultWh);

            _db.PackingStations.Add(new PackingStation
            {
                Id = Guid.NewGuid(),
                WarehouseId = defaultWh.Id,
                Code = "ST-01",
                Name = "Bàn đóng gói 01",
                IsActive = true,
                CreatedAtUtc = now
            });

            createdWarehouses.Add(new AdminWarehouseStorageDto(
                Id: defaultWh.Id,
                ShopId: shop.Id,
                Code: defaultWh.Code,
                Name: defaultWh.Name,
                IsActive: true,
                PackingStationCount: 1,
                CreatedAtUtc: now));
        }

        var profile = await LoadOrCreateActiveStorageProfileAsync(ct);
        var activeSubdirs = await _db.Shops
            .AsNoTracking()
            .Where(s => s.IsActive)
            .Select(s => s.AllowedStorageSubdir)
            .ToListAsync(ct);
        activeSubdirs.Add(safeSubdir);

        profile.AllowedSubdirectoriesJson = JsonSerializer.Serialize(
            activeSubdirs.Distinct(StringComparer.OrdinalIgnoreCase)
                         .OrderBy(s => s, StringComparer.OrdinalIgnoreCase)
                         .ToArray());
        profile.UpdatedAtUtc = now;
        profile.UpdatedByUserId = actorId;

        await _db.SaveChangesAsync(ct);

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "admin.shop.create",
            EntityType: "Shop",
            EntityId: shop.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: actorId,
            ActorEmail: actorEmail,
            ShopId: shop.Id,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new { shop.Code, shop.Slug, shop.Name, shop.AllowedStorageSubdir, request.CreateDefaultWarehouse }), ct);

        return StatusCode(StatusCodes.Status201Created, new AdminShopStorageDto(
            Id: shop.Id,
            Code: shop.Code,
            Slug: shop.Slug,
            Name: shop.Name,
            AllowedStorageSubdir: shop.AllowedStorageSubdir,
            IsActive: shop.IsActive,
            CreatedAtUtc: shop.CreatedAtUtc,
            Warehouses: createdWarehouses));
    }

    [HttpPost("shops/{shopId:guid}/warehouses")]
    public async Task<ActionResult<AdminWarehouseStorageDto>> CreateWarehouse(
        Guid shopId,
        [FromBody] CreateAdminWarehouseRequest request,
        CancellationToken ct)
    {
        var actorId = HttpContext.GetRequiredUserId();
        var actorEmail = HttpContext.GetUserEmail();

        if (!await EnsureStorageManagePermissionAsync(actorId, "admin.warehouse.create", ct))
        {
            return ForbiddenStorageManage();
        }

        var shop = await _db.Shops
            .AsNoTracking()
            .FirstOrDefaultAsync(s => s.Id == shopId, ct);

        if (shop is null)
        {
            return NotFound(new ApiErrorResponse(
                "SHOP_NOT_FOUND",
                "Không tìm thấy Shop cần thêm kho."));
        }

        var code = request.Code?.Trim() ?? string.Empty;
        var name = request.Name?.Trim() ?? string.Empty;

        if (string.IsNullOrWhiteSpace(code) || code.Length > 32 || !SafeOrgCodeRegex().IsMatch(code))
        {
            return BadRequest(new ApiErrorResponse(
                "INVALID_WAREHOUSE_CODE",
                "Mã Kho bắt buộc (tối đa 32 ký tự, chỉ gồm chữ không dấu, số, '-' hoặc '_')."));
        }

        if (string.IsNullOrWhiteSpace(name) || name.Length > 128)
        {
            return BadRequest(new ApiErrorResponse(
                "INVALID_WAREHOUSE_NAME",
                "Tên Kho bắt buộc và không vượt quá 128 ký tự."));
        }

        var duplicateCode = await _db.Warehouses
            .AsNoTracking()
            .AnyAsync(w =>
                w.ShopId == shopId &&
                w.Code.ToLower() == code.ToLower(), ct);

        if (duplicateCode)
        {
            return Conflict(new ApiErrorResponse(
                "DUPLICATE_WAREHOUSE_CODE",
                "Mã Kho này đã tồn tại trong Shop đã chọn."));
        }

        var now = DateTime.UtcNow;
        var warehouse = new Warehouse
        {
            Id = Guid.NewGuid(),
            ShopId = shopId,
            Code = code,
            Name = name,
            IsActive = true,
            CreatedAtUtc = now
        };

        _db.Warehouses.Add(warehouse);

        var stationCount = 0;
        if (request.CreateDefaultStation)
        {
            _db.PackingStations.Add(new PackingStation
            {
                Id = Guid.NewGuid(),
                WarehouseId = warehouse.Id,
                Code = "ST-01",
                Name = "Bàn đóng gói 01",
                IsActive = true
            });
            stationCount = 1;
        }

        await _db.SaveChangesAsync(ct);

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: "admin.warehouse.create",
            EntityType: "Warehouse",
            EntityId: warehouse.Id.ToString(),
            Outcome: AuditOutcome.Success,
            ActorUserId: actorId,
            ActorEmail: actorEmail,
            ShopId: shopId,
            WarehouseId: warehouse.Id,
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new { shopCode = shop.Code, warehouse.Code, warehouse.Name }), ct);

        return StatusCode(StatusCodes.Status201Created, new AdminWarehouseStorageDto(
            Id: warehouse.Id,
            ShopId: warehouse.ShopId,
            Code: warehouse.Code,
            Name: warehouse.Name,
            IsActive: warehouse.IsActive,
            PackingStationCount: stationCount,
            CreatedAtUtc: warehouse.CreatedAtUtc));
    }

    private async Task<bool> EnsureStorageManagePermissionAsync(
        Guid actorId,
        string attemptedAction,
        CancellationToken ct)
    {
        var access = await _scopeAuth.GetEffectiveAccessAsync(actorId, ct);
        if (access.IsActive && access.AllPermissions.Contains(PermissionCatalog.StorageManage))
        {
            return true;
        }

        await _auditLogger.AppendAsync(new AuditEntryRequest(
            Action: attemptedAction,
            EntityType: "StorageProfile",
            Outcome: AuditOutcome.Denied,
            ActorUserId: actorId,
            ActorEmail: HttpContext.GetUserEmail(),
            IpAddress: HttpContext.GetClientIp(),
            UserAgent: HttpContext.GetUserAgent(),
            Metadata: new { reason = "FORBIDDEN_STORAGE_MANAGE" }), ct);

        return false;
    }

    private ObjectResult ForbiddenStorageManage() =>
        StatusCode(StatusCodes.Status403Forbidden, new ApiErrorResponse(
            "FORBIDDEN",
            "Bạn không có quyền quản trị cấu hình lưu trữ hệ thống (storage.manage)."));

    private async Task<StorageProfile> LoadOrCreateActiveStorageProfileAsync(CancellationToken ct)
    {
        var profile = await _db.StorageProfiles
            .OrderBy(p => p.Name)
            .FirstOrDefaultAsync(ct);

        if (profile is not null)
        {
            if (profile.Mode != _options.StorageMode)
            {
                profile.Mode = _options.StorageMode;
            }
            return profile;
        }

        profile = new StorageProfile
        {
            Id = Guid.NewGuid(),
            Name = "Default",
            Mode = _options.StorageMode,
            ExpectedStorageId = _options.StorageId,
            AllowedSubdirectoriesJson = "[]",
            MaxRecordingSeconds = _options.MaxRecordingSeconds,
            MaxUploadBytes = _options.MaxUploadBytes,
            MaxLocalPendingRecordings = _options.MaxLocalPendingRecordings,
            RetentionEnabled = _options.RetentionEnabled,
            RetentionDays = _options.RetentionDays,
            EnableAudioRecording = _options.EnableAudioRecording,
            UpdatedAtUtc = DateTime.UtcNow
        };

        _db.StorageProfiles.Add(profile);
        await _db.SaveChangesAsync(ct);
        return profile;
    }

    private async Task<AdminStorageOverviewDto> BuildStorageOverviewAsync(
        StorageProfile profile,
        CancellationToken ct)
    {
        var snapshot = await _stagingQuotaGuard.GetSnapshotAsync(ct: ct);
        var shops = await _db.Shops
            .AsNoTracking()
            .Include(s => s.Warehouses)
                .ThenInclude(w => w.PackingStations)
            .OrderBy(s => s.Name)
            .ToListAsync(ct);

        var shopDtos = shops
            .Select(s => new AdminShopStorageDto(
                Id: s.Id,
                Code: s.Code,
                Slug: s.Slug,
                Name: s.Name,
                AllowedStorageSubdir: s.AllowedStorageSubdir,
                IsActive: s.IsActive,
                CreatedAtUtc: s.CreatedAtUtc,
                Warehouses: s.Warehouses
                    .OrderBy(w => w.Name)
                    .Select(w => new AdminWarehouseStorageDto(
                        Id: w.Id,
                        ShopId: w.ShopId,
                        Code: w.Code,
                        Name: w.Name,
                        IsActive: w.IsActive,
                        PackingStationCount: w.PackingStations.Count(p => p.IsActive),
                        CreatedAtUtc: w.CreatedAtUtc))
                    .ToList()))
            .ToList();

        var allowedSubdirs = ParseAllowedSubdirectories(profile.AllowedSubdirectoriesJson, shops);

        return new AdminStorageOverviewDto(
            ProfileId: profile.Id,
            ProfileName: profile.Name,
            StorageMode: _options.StorageMode,
            ExpectedStorageIdConfigured: !string.IsNullOrWhiteSpace(_options.StorageId),
            MarkerFileName: FileSystemVideoStorage.StorageMarkerFileName,
            MaxRecordingSeconds: profile.MaxRecordingSeconds,
            MaxUploadBytes: profile.MaxUploadBytes,
            MaxLocalPendingRecordings: profile.MaxLocalPendingRecordings,
            UploadChunkBytes: _options.UploadChunkBytes,
            EnableAudioRecording: profile.EnableAudioRecording,
            RetentionEnabled: profile.RetentionEnabled,
            RetentionDays: profile.RetentionDays,
            StagingUsage: new StagingUsageDto(
                MaxStagingBytes: snapshot.MaxStagingBytes,
                DiskUsedBytes: snapshot.DiskUsedBytes,
                ReservedRemainingBytes: snapshot.ReservedRemainingBytes,
                TotalFootprintBytes: snapshot.TotalFootprintBytes,
                AvailableBytes: snapshot.AvailableBytes),
            AllowedSubdirectories: allowedSubdirs,
            Shops: shopDtos,
            UpdatedAtUtc: profile.UpdatedAtUtc);
    }

    private bool TryValidateAndSanitizeSubdirectory(
        string? rawSubdir,
        out string sanitizedSubdir,
        out string? userSafeError)
    {
        sanitizedSubdir = string.Empty;
        userSafeError = null;

        if (string.IsNullOrWhiteSpace(rawSubdir))
        {
            userSafeError = "Tên thư mục con lưu trữ không được để trống.";
            return false;
        }

        var trimmed = rawSubdir.Trim();
        if (trimmed.Length > 64)
        {
            userSafeError = "Tên thư mục con lưu trữ không được vượt quá 64 ký tự.";
            return false;
        }

        if (trimmed.Contains('/') ||
            trimmed.Contains('\\') ||
            trimmed.Contains("..", StringComparison.Ordinal) ||
            trimmed.Contains(':') ||
            !SafeSingleSubdirRegex().IsMatch(trimmed))
        {
            userSafeError = "Thư mục con lưu trữ chỉ cho phép một cấp tên thư mục an toàn (chữ cái không dấu, chữ số, '-' hoặc '_'), không chứa dấu phân cách đường dẫn hay '..'.";
            return false;
        }

        try
        {
            var safeSegment = PathSegmentSanitizer.ToSafeSegment(trimmed);
            var fullRoot = Path.GetFullPath(_options.NasRootPath);
            _ = PathSegmentSanitizer.CombineWithinRoot(fullRoot, safeSegment);
            sanitizedSubdir = safeSegment;
            return true;
        }
        catch (Exception)
        {
            userSafeError = "Tên thư mục con lưu trữ không hợp lệ hoặc vi phạm giới hạn thư mục gốc.";
            return false;
        }
    }

    private (long? FreeBytes, long? TotalBytes, bool IsLowWarning, string? WarningMessage) InspectStorageCapacityBestEffort(
        bool rootExists,
        long maxUploadBytes)
    {
        if (!rootExists)
        {
            return (null, null, false, null);
        }

        try
        {
            var fullRoot = Path.GetFullPath(_options.NasRootPath);
            var rootAnchor = Path.GetPathRoot(fullRoot);
            if (string.IsNullOrWhiteSpace(rootAnchor))
            {
                return (null, null, false, null);
            }

            var drive = new DriveInfo(rootAnchor);
            if (!drive.IsReady)
            {
                return (null, null, false, null);
            }

            var free = drive.AvailableFreeSpace;
            var total = drive.TotalSize;
            var warningThreshold = Math.Max(LowFreeSpaceFloorBytes, maxUploadBytes * 4);
            var isLow = free < warningThreshold || (total > 0 && (double)free / total < 0.08);
            var warningMsg = isLow
                ? "Cảnh báo dung lượng trống trên kho lưu trữ đang ở mức thấp (< 8% hoặc dưới ngưỡng an toàn). Vui lòng kiểm tra dung lượng ổ đĩa/NAS."
                : null;

            return (free, total, isLow, warningMsg);
        }
        catch
        {
            // UNC shares or virtual mounts may not expose DriveInfo metrics on all OS hosts
            return (null, null, false, null);
        }
    }

    private static string BuildVietnameseHealthStatusMessage(StorageHealthReport report)
    {
        if (report.IsHealthy)
        {
            return report.Mode == StorageMode.SynologyMounted
                ? "Kết nối Synology NAS hoạt động tốt: thư mục share tồn tại, tệp định danh STORAGE_ID hợp lệ và kiểm tra đọc/ghi thành công."
                : "Chế độ thử nghiệm lưu cục bộ (LocalDevelopment) hoạt động bình thường: kiểm tra đọc/ghi và tệp định danh thành công.";
        }

        return report.ErrorCode switch
        {
            "NAS_STORAGE_MARKER_INVALID" when !report.RootExists =>
                "Không tìm thấy thư mục mount Synology NAS trên máy chủ. Hệ thống không tự tạo thư mục cục bộ thay thế.",
            "NAS_STORAGE_MARKER_INVALID" =>
                "Tệp định danh kho lưu trữ (.packingproof-storage-id) bị thiếu hoặc không khớp cấu hình STORAGE_ID.",
            "NAS_WRITE_UNAVAILABLE" =>
                "Kho lưu trữ Synology NAS không thể đọc/ghi tệp kiểm tra (thiếu quyền ghi, đầy dung lượng hoặc lỗi kết nối).",
            "LOCAL_STORAGE_WRITE_FAILED" or "LOCAL_STORAGE_UNAVAILABLE" =>
                "Thư mục lưu trữ cục bộ hiện không khả dụng hoặc không có quyền ghi.",
            _ => "Kiểm tra kết nối kho lưu trữ không thành công. Vui lòng kiểm tra cấu hình triển khai và quyền truy cập."
        };
    }

    private static IReadOnlyList<string> ParseAllowedSubdirectories(string? rawJson, IReadOnlyList<Shop> shops)
    {
        var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        if (!string.IsNullOrWhiteSpace(rawJson))
        {
            try
            {
                var parsed = JsonSerializer.Deserialize<string[]>(rawJson);
                if (parsed is not null)
                {
                    foreach (var item in parsed)
                    {
                        if (!string.IsNullOrWhiteSpace(item))
                        {
                            result.Add(item.Trim());
                        }
                    }
                }
            }
            catch (JsonException)
            {
                // Fall back to active shop subdirectories
            }
        }

        foreach (var shop in shops.Where(s => s.IsActive && !string.IsNullOrWhiteSpace(s.AllowedStorageSubdir)))
        {
            result.Add(shop.AllowedStorageSubdir);
        }

        return result.OrderBy(s => s, StringComparer.OrdinalIgnoreCase).ToList();
    }

    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9_-]{0,62}[A-Za-z0-9]$|^[A-Za-z0-9]$", RegexOptions.CultureInvariant)]
    private static partial Regex SafeSingleSubdirRegex();

    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$", RegexOptions.CultureInvariant)]
    private static partial Regex SafeOrgCodeRegex();
}
