-- =====================================================================
--  Users & authentication
--
--  JWT-based auth. The app's own users table lives in the audit schema's
--  sibling — core — because it is application data, not a lookup.
--
--  SUPER_ADMIN is seeded from environment variables on first boot
--  (see apps/api/src/auth/seed-super-admin.ts). It is a normal row
--  afterwards, so it can be managed like any other user.
-- =====================================================================

SET NOCOUNT ON;
GO

IF OBJECT_ID('core.AppUser', 'U') IS NULL
BEGIN
    CREATE TABLE core.AppUser (
        UserID        INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_AppUser PRIMARY KEY,
        Email         NVARCHAR(255) NOT NULL,
        DisplayName   NVARCHAR(150) NOT NULL,
        PasswordHash  NVARCHAR(255) NOT NULL,   -- bcrypt, cost 12
        Role          NVARCHAR(20)  NOT NULL,
        IsActive      BIT           NOT NULL CONSTRAINT DF_AppUser_IsActive DEFAULT 1,
        -- Opt out of notification emails (workshop capacity alerts today,
        -- more later). The in-app bell is unaffected; see migration 015.
        ReceivesAdminEmail BIT      NOT NULL CONSTRAINT DF_AppUser_ReceivesAdminEmail DEFAULT 1,
        IsSeeded      BIT           NOT NULL CONSTRAINT DF_AppUser_IsSeeded DEFAULT 0,  -- came from env
        LastLoginAt   DATETIME2(0)  NULL,
        PasswordChangedAt DATETIME2(0) NULL,
        CreatedAt     DATETIME2(0)  NOT NULL CONSTRAINT DF_AppUser_CreatedAt DEFAULT SYSUTCDATETIME(),
        UpdatedAt     DATETIME2(0)  NOT NULL CONSTRAINT DF_AppUser_UpdatedAt DEFAULT SYSUTCDATETIME(),
        CONSTRAINT UQ_AppUser_Email UNIQUE (Email),
        CONSTRAINT CK_AppUser_Role CHECK (Role IN ('SUPER_ADMIN','ADMIN','MANAGER','EDITOR','VIEWER'))
    );
    CREATE INDEX IX_AppUser_Role ON core.AppUser(Role, IsActive);
    PRINT 'core.AppUser created';
END
ELSE
    PRINT 'core.AppUser already exists';
GO

-- Refresh tokens are stored hashed so a database leak cannot be replayed.
IF OBJECT_ID('core.RefreshToken', 'U') IS NULL
BEGIN
    CREATE TABLE core.RefreshToken (
        RefreshTokenID INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_RefreshToken PRIMARY KEY,
        UserID         INT           NOT NULL REFERENCES core.AppUser(UserID),
        TokenHash      VARBINARY(32) NOT NULL,   -- SHA-256 of the opaque token
        ExpiresAt      DATETIME2(0)  NOT NULL,
        RevokedAt      DATETIME2(0)  NULL,
        CreatedAt      DATETIME2(0)  NOT NULL CONSTRAINT DF_RefreshToken_CreatedAt DEFAULT SYSUTCDATETIME(),
        UserAgent      NVARCHAR(400) NULL,
        IpHash         VARBINARY(32) NULL
    );
    CREATE INDEX IX_RefreshToken_User ON core.RefreshToken(UserID, ExpiresAt);
    CREATE UNIQUE INDEX UX_RefreshToken_Hash ON core.RefreshToken(TokenHash);
    PRINT 'core.RefreshToken created';
END
ELSE
    PRINT 'core.RefreshToken already exists';
GO

-- Login attempts, for lockout and abuse detection.
IF OBJECT_ID('audit.LoginAttempt', 'U') IS NULL
BEGIN
    CREATE TABLE audit.LoginAttempt (
        LoginAttemptID BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_LoginAttempt PRIMARY KEY,
        Email          NVARCHAR(255) NULL,
        Succeeded      BIT           NOT NULL,
        Reason         NVARCHAR(100) NULL,
        IpHash         VARBINARY(32) NULL,
        AttemptedAt    DATETIME2(0)  NOT NULL CONSTRAINT DF_LoginAttempt_At DEFAULT SYSUTCDATETIME()
    );
    CREATE INDEX IX_LoginAttempt_Email ON audit.LoginAttempt(Email, AttemptedAt);
    PRINT 'audit.LoginAttempt created';
END
ELSE
    PRINT 'audit.LoginAttempt already exists';
GO
