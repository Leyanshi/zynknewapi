package router

import (
	"net/http"
	"testing"

	"github.com/QuantumNous/new-api/setting/site_setting"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const webIndexPageForTest = "<!doctype html><html><head><title>New API</title></head><body>dashboard</body></html>"

func TestWebIndexPageInjectsCustomHeadHTML(t *testing.T) {
	gin.SetMode(gin.TestMode)

	settings := site_setting.GetSiteSetting()
	previous := settings.CustomHeadHTML
	t.Cleanup(func() {
		settings.CustomHeadHTML = previous
	})
	settings.CustomHeadHTML = `<meta name="robots" content="noindex">`

	outer := gin.New()
	SetWebRouter(outer, WebAssets{IndexPage: []byte(webIndexPageForTest)}, func(c *gin.Context) { c.Next() })

	for _, path := range []string{"/", "/index.html", "/security"} {
		t.Run(path, func(t *testing.T) {
			response := performPluginRequest(outer, http.MethodGet, path)
			require.Equal(t, http.StatusOK, response.Code)
			assert.Contains(t, response.Body.String(), `<meta name="robots" content="noindex">`+"\n"+`</head>`)
			assert.Equal(t, "no-cache", response.Header().Get("Cache-Control"))
		})
	}
}

func TestWebIndexInjectionSkipsAPIPaths(t *testing.T) {
	gin.SetMode(gin.TestMode)

	settings := site_setting.GetSiteSetting()
	previous := settings.CustomHeadHTML
	t.Cleanup(func() {
		settings.CustomHeadHTML = previous
	})
	settings.CustomHeadHTML = `<meta name="robots" content="noindex">`

	outer := gin.New()
	SetWebRouter(outer, WebAssets{IndexPage: []byte(webIndexPageForTest)}, func(c *gin.Context) { c.Next() })

	for _, path := range []string{"/api/missing", "/v1/missing", "/assets/missing.js"} {
		t.Run(path, func(t *testing.T) {
			response := performPluginRequest(outer, http.MethodGet, path)
			assert.NotContains(t, response.Body.String(), "noindex")
		})
	}
}

func TestWebIndexPageWithoutSiteHTMLIsUnchanged(t *testing.T) {
	gin.SetMode(gin.TestMode)

	settings := site_setting.GetSiteSetting()
	previousTitle := settings.HomePageTitle
	previousHeadHTML := settings.CustomHeadHTML
	t.Cleanup(func() {
		settings.HomePageTitle = previousTitle
		settings.CustomHeadHTML = previousHeadHTML
	})
	settings.HomePageTitle = ""
	settings.CustomHeadHTML = ""

	outer := gin.New()
	SetWebRouter(outer, WebAssets{IndexPage: []byte(webIndexPageForTest)}, func(c *gin.Context) { c.Next() })

	response := performPluginRequest(outer, http.MethodGet, "/")
	require.Equal(t, http.StatusOK, response.Code)
	assert.Equal(t, webIndexPageForTest, response.Body.String())
}

func TestWebHomePageTitleOnlyOnHomePage(t *testing.T) {
	gin.SetMode(gin.TestMode)

	settings := site_setting.GetSiteSetting()
	previous := settings.HomePageTitle
	t.Cleanup(func() {
		settings.HomePageTitle = previous
	})
	settings.HomePageTitle = "Welcome & More"

	outer := gin.New()
	SetWebRouter(outer, WebAssets{IndexPage: []byte(webIndexPageForTest)}, func(c *gin.Context) { c.Next() })

	for _, path := range []string{"/", "/index.html"} {
		t.Run(path, func(t *testing.T) {
			response := performPluginRequest(outer, http.MethodGet, path)
			require.Equal(t, http.StatusOK, response.Code)
			assert.Contains(t, response.Body.String(), "<title>Welcome &amp; More</title>")
		})
	}

	t.Run("/security", func(t *testing.T) {
		response := performPluginRequest(outer, http.MethodGet, "/security")
		require.Equal(t, http.StatusOK, response.Code)
		assert.Contains(t, response.Body.String(), "<title>New API</title>")
		assert.NotContains(t, response.Body.String(), "Welcome &amp; More")
	})
}
