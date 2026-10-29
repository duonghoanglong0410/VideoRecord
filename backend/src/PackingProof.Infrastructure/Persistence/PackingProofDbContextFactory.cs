using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace PackingProof.Infrastructure.Persistence;

public sealed class PackingProofDbContextFactory : IDesignTimeDbContextFactory<PackingProofDbContext>
{
    public PackingProofDbContext CreateDbContext(string[] args)
    {
        var connectionString = Environment.GetEnvironmentVariable("DATABASE_CONNECTION");
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            connectionString = "Host=localhost;Port=5432;Database=packingproof_design;Username=postgres";
        }

        var optionsBuilder = new DbContextOptionsBuilder<PackingProofDbContext>();
        optionsBuilder.UseNpgsql(connectionString);
        return new PackingProofDbContext(optionsBuilder.Options);
    }
}

