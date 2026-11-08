package controller

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCustomOAuthDiscoveryRejectsPrivateTargets(t *testing.T) {
	for _, target := range []string{
		"http://127.0.0.1/metadata",
		"http://169.254.169.254/latest/meta-data",
		"http://[::1]/",
		"http://user:password@example.com/.well-known/openid-configuration",
	} {
		t.Run(target, func(t *testing.T) {
			require.Error(t, validateCustomOAuthDiscoveryTarget(context.Background(), target))
		})
	}
}
