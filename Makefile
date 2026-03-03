# ===================== 自定义配置（根据需求修改） =====================
# npm依赖包列表
NPM_PACKAGES := yo generator-code axios
PLUGIN_NAME := dbviewer
PLUGIN_ID := dbviewer
PLUGIN_DESC := dbviewer
# =====================================================================

all: prepare build package

.PHONY: prepare build package

prepare:
	@echo "==== 检查必要的npm包是否安装 ===="
	@for pkg in $(NPM_PACKAGES); do \
		if npm list -g --depth=0 $$pkg > /dev/null 2>&1; then \
			echo "✅ 包 $$pkg 已全局安装"; \
		else \
			echo "❌ 包 $$pkg 未安装，正在全局安装..."; \
			if npm install -g $$pkg; then \
				echo "✅ 包 $$pkg 安装成功"; \
			else \
				echo "❌ 包 $$pkg 安装失败，请手动检查npm环境或权限"; \
				exit 1; \
			fi; \
		fi; \
	done
	@echo "==== 所有必要npm包检查/安装完成 ===="

generate:
	@echo "==== 生成VSCode插件 ===="
	yo code $(PLUGIN_NAME) . --extensionType ts --extensionDisplayName $(PLUGIN_NAME) --ask-answered --extensionId $(PLUGIN_ID) --extensionDescription $(PLUGIN_DESC) -q --force-install
	@echo "==== VSCode插件生成完成 ===="

build:
	npm install && npm run compile

package:
	npm run package