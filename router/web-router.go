package router

import (
	"bytes"
	"embed"
	"net/http"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/setting/site_setting"
	"github.com/gin-contrib/gzip"
	"github.com/gin-contrib/static"
	"github.com/gin-gonic/gin"
)

// WebAssets holds the embedded dashboard frontend assets.
type WebAssets struct {
	BuildFS   embed.FS
	IndexPage []byte
}

func SetWebRouter(router *gin.Engine, assets WebAssets, pluginDispatcher gin.HandlerFunc) {
	frontendFS := common.EmbedFolder(assets.BuildFS, "web/dist")

	router.NoRoute(
		pluginDispatcher,
		middleware.RouteTag("web"),
		gzip.Gzip(gzip.DefaultCompression),
		middleware.AccessTokenAudit(),
		middleware.GlobalWebRateLimit(),
		middleware.Cache(),
		// index.html exists in the embedded frontend, so static.Serve would
		// serve the raw file and skip the custom head injection below.
		func(c *gin.Context) {
			if c.Request.URL.Path != "/index.html" {
				return
			}
			serveIndexPage(c, assets.IndexPage)
			c.Abort()
		},
		static.Serve("/", frontendFS),
		func(c *gin.Context) {
			if strings.HasPrefix(c.Request.RequestURI, "/v1") || strings.HasPrefix(c.Request.RequestURI, "/api") || strings.HasPrefix(c.Request.RequestURI, "/assets") {
				controller.RelayNotFound(c)
				return
			}
			serveIndexPage(c, assets.IndexPage)
		},
	)
}

func serveIndexPage(c *gin.Context, indexPage []byte) {
	c.Header("Cache-Control", "no-cache")
	c.Data(http.StatusOK, "text/html; charset=utf-8", injectCustomHeadHTML(indexPage))
}

func injectCustomHeadHTML(indexPage []byte) []byte {
	customHeadHTML := site_setting.GetSiteSetting().CustomHeadHTML
	if strings.TrimSpace(customHeadHTML) == "" {
		return indexPage
	}

	headEnd := bytes.Index(indexPage, []byte("</head>"))
	if headEnd < 0 {
		return indexPage
	}

	page := make([]byte, 0, len(indexPage)+len(customHeadHTML)+1)
	page = append(page, indexPage[:headEnd]...)
	page = append(page, customHeadHTML...)
	page = append(page, '\n')
	page = append(page, indexPage[headEnd:]...)
	return page
}
