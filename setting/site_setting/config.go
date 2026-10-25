package site_setting

import "github.com/QuantumNous/new-api/setting/config"

type SiteSetting struct {
	HomePageTitle  string `json:"home_page_title"`  // Document title used only on the homepage
	CustomHeadHTML string `json:"custom_head_html"` // HTML injected into the document head of frontend pages
}

var defaultSiteSetting = SiteSetting{
	HomePageTitle:  "",
	CustomHeadHTML: "",
}

var siteSetting = defaultSiteSetting

func init() {
	config.GlobalConfig.Register("site_setting", &siteSetting)
}

func GetSiteSetting() *SiteSetting {
	return &siteSetting
}
