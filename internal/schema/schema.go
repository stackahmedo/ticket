package schema

import "embed"

// Files contains the ordered, versioned migrations.
//
//go:embed migrations/*.sql
var Files embed.FS
