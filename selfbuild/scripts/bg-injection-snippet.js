	//#region deepdive 背景图注入（样式表 dsh-bg.css —— 背景图与遮罩都在里面；不想要就删掉本段）
	// ⚠️ 这段是"本地改动"，而它所在的文件同时在 build-overlay 里（上游干净版没有它）。
	//    出包时 overlay 会覆盖掉它 → 背景图彻底不显示。所以：
	//    selfbuild.sh patch 之后会跑 check-bg-injection.js 把关，缺了就报错。
	(function () {
		try {
			var ID = "dsh-user-bg";
			var old = document.getElementById(ID);
			if (old && old.parentNode) old.parentNode.removeChild(old);
			var link = document.createElement("link");
			link.id = ID;
			link.rel = "stylesheet";
			link.href = "/dsh-bg.css?rev=" + Date.now();
			(document.head || document.documentElement).appendChild(link);
		} catch (e) { /* 背景图失败不影响本插件 */ }
	})();
	//#endregion
