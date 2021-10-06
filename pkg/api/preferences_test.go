package api

import (
	"net/http"
	"testing"

	"github.com/grafana/grafana/pkg/services/accesscontrol"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var (
	getOrgPreferencesURL = "/api/org/preferences/"
)

func TestAPIEndpoint_GetCurrentOrgPreferences_LegacyAccessControl(t *testing.T) {
	sc := setupHTTPServer(t, false)

	_, err := sc.db.CreateOrgWithMember("TestOrg", testUserID)
	require.NoError(t, err)

	setInitCtxSignedInViewer(sc.initCtx)
	t.Run("Viewer cannot get org preferences", func(t *testing.T) {
		response := callAPI(sc.server, http.MethodGet, getOrgPreferencesURL, nil, t)
		assert.Equal(t, http.StatusForbidden, response.Code)
	})

	setInitCtxSignedInOrgAdmin(sc.initCtx)
	t.Run("Org Admin can get org preferences", func(t *testing.T) {
		response := callAPI(sc.server, http.MethodGet, getOrgPreferencesURL, nil, t)
		assert.Equal(t, http.StatusOK, response.Code)
	})
}

func TestAPIEndpoint_GetCurrentOrgPreferences_AccessControl(t *testing.T) {
	sc := setupHTTPServer(t, true)
	setInitCtxSignedInViewer(sc.initCtx)

	_, err := sc.db.CreateOrgWithMember("TestOrg", testUserID)
	require.NoError(t, err)

	t.Run("AccessControl allows getting org preferences with correct permissions", func(t *testing.T) {
		setAccessControlPermissions(sc.acmock, []*accesscontrol.Permission{{Action: ActionOrgsPreferencesRead, Scope: ScopeOrgsAll}})
		response := callAPI(sc.server, http.MethodGet, getOrgPreferencesURL, nil, t)
		assert.Equal(t, http.StatusOK, response.Code)
	})
	t.Run("AccessControl allows getting org preferences with exact permissions", func(t *testing.T) {
		setAccessControlPermissions(sc.acmock, []*accesscontrol.Permission{{Action: ActionOrgsPreferencesRead, Scope: accesscontrol.Scope("orgs", "id", "1")}})
		response := callAPI(sc.server, http.MethodGet, getOrgPreferencesURL, nil, t)
		assert.Equal(t, http.StatusOK, response.Code)
	})
	t.Run("AccessControl prevents getting org preferences with incorrect permissions", func(t *testing.T) {
		setAccessControlPermissions(sc.acmock, []*accesscontrol.Permission{{Action: "orgs:invalid"}})
		response := callAPI(sc.server, http.MethodGet, getOrgPreferencesURL, nil, t)
		assert.Equal(t, http.StatusForbidden, response.Code)
	})
}
