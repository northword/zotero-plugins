import fs from "fs";
import { franc } from "franc-min";
// import translate from "google-translate-api-x";
import AdmZip from "adm-zip";
import * as xml2js from "xml2js";
import { PluginInfo, PluginInfoBase } from "./types";
import { writeFile } from "./utils";
import { octokit } from ".";
import { dist } from ".";
import { jsonc } from "jsonc";

export function fetchPlugins(plugins: PluginInfoBase[]) {
  return Promise.all(plugins.map(fetchPlugin));
}

async function fetchPlugin(pluginBase: PluginInfoBase): Promise<PluginInfo> {
  const plugin = pluginBase as PluginInfo;
  const repoParts = pluginBase.repo.split("/"),
    owner = repoParts[0],
    repo = repoParts[1];

  // 仓库信息：插件简介
  await octokit.rest.repos.get({ owner, repo }).then((resp) => {
    let desc = "";
    if (resp.data.description) {
      if (franc(resp.data.description) == "cmn") {
        desc = resp.data.description;
      } else {
        desc = resp.data.description;
        // 翻译
        // console.log("需要翻译");
        // await translate(resp.data.description, { to: "zh-CN" })
        //   .then((res) => {
        //     console.log(res.text);
        //     desc = res.text;
        //   })
        //   .catch((e) => {
        //     console.log(e);
        //     desc = resp.data.description;
        //   });
      }
    }

    plugin.description = desc;
    plugin.star = resp.data.stargazers_count;
    plugin.stars = resp.data.stargazers_count;
    plugin.watchers = resp.data.subscribers_count;
  });

  // 作者信息
  await octokit.rest.users.getByUsername({ username: owner }).then(
    (resp) =>
      (plugin.author = {
        name: resp.data.name || owner,
        url: resp.data.blog || resp.data.html_url,
        avatar: resp.data.avatar_url,
      })
  );

  // 发行版
  for (const release of plugin.releases) {
    async function getRelease() {
      if (release.tagName == "latest") {
        const resp = await octokit.rest.repos.getLatestRelease({ owner, repo });
        return resp.data;
      } else if (release.tagName == "pre") {
        const resp = await octokit.rest.repos.listReleases({ owner, repo });
        return resp.data.filter((item) => item.prerelease)[0];
      } else {
        const resp = await octokit.rest.repos.getReleaseByTag({
          owner,
          repo,
          tag: release.tagName,
        });
        return resp.data;
      }
    }

    await getRelease().then(async (resp) => {
      release.tagName = resp.tag_name;

      const asset = resp.assets
        .filter((asset) => asset.content_type === "application/x-xpinstall")
        .sort((a, b) => {
          const dateA = new Date(a.updated_at);
          const dateB = new Date(b.updated_at);
          // 使用时间戳进行比较
          return dateB.getTime() - dateA.getTime();
        })[0];

      if (!asset) {
        console.log(`  ${plugin.name} ${release.tagName} 不存在 XPI`);
        // throw new Error(`${plugin.name} ${release.tagName} 不存在 XPI`);
        return;
      }

      if (!fs.existsSync(`${dist}/xpi/${asset.id}.xpi`)) {
        const xpiFlie = await octokit.rest.repos
          .getReleaseAsset({
            owner: owner,
            repo: repo,
            asset_id: asset.id,
            headers: {
              Accept: "application/octet-stream",
            },
          })
          .then((resp) => {
            writeFile(
              `${dist}/xpi/${asset.id}.xpi`,
              Buffer.from(resp.data as unknown as ArrayBuffer)
            );
          });
      }

      release.assetId = asset.id;
      release.releaseDate = asset.updated_at;
      release.downloadCount = asset.download_count;
      release.xpiDownloadUrl = {
        github: asset.browser_download_url,
        gitee: `https://gitee.com/northword/zotero-plugins/raw/gh-pages/dist/xpi/${release.assetId}.xpi`,
        ghProxy: `https://ghproxy.com/?q=${encodeURI(
          asset.browser_download_url
        )}`,
        jsdeliver: `https://cdn.jsdelivr.net/gh/northword/zotero-plugins@gh-pages/dist/xpi/${release.assetId}.xpi`,
        kgithub: asset.browser_download_url.replace(
          "github.com",
          "kkgithub.com"
        ),
      };
    });

    // if (plugin.releases.length > 1 && release.targetZoteroVersion == "6")
    //   continue;

    // 拆 XPI 包
    const zip = new AdmZip(`${dist}/xpi/${release.assetId}.xpi`);
    const zipEntries = zip.getEntries();
    const zipEntryNames = zipEntries.map((zipEntrie) => zipEntrie.entryName);
    if (zipEntryNames.includes("manifest.json")) {
      const fileData = zip
        .getEntry("manifest.json")!
        .getData()
        .toString("utf8");
      const manifestData = jsonc.parse(fileData);

      plugin.name =
        release.targetZoteroVersion == "7"
          ? manifestData.name
          : plugin.name ?? manifestData.name ?? repo;
      if (plugin.name == "__MSG_name__") {
        if (zipEntryNames.includes("_locales/zh-CN/messages.json")) {
          const message = zip
            .getEntry("_locales/zh-CN/messages.json")!
            .getData()
            .toString("utf8");
          const messageData = jsonc.parse(message);
          plugin.name = messageData.name.message;
        } else {
          plugin.name = repo;
        }
      }
      release.id = manifestData.applications.zotero.id;
      release.xpiVersion = manifestData.version || "";
      plugin.description = plugin.description || manifestData.description || "";
      // todo: 适配多语言，当值为 `__MSG_description__` 是前往 i18n 目录获取
    } else if (zipEntryNames.includes("install.rdf")) {
      const fileData = zip.getEntry("install.rdf")!.getData().toString("utf8");

      // 从 install.rdf 中获取 id
      function replaceRDF(name: string) {
        return name.replace("RDF:", "");
      }
      xml2js.parseString(
        fileData,
        {
          mergeAttrs: true,
          attrNameProcessors: [replaceRDF],
          tagNameProcessors: [replaceRDF],
        },
        (err, result) => {
          const manifestData = result; //JSON.parse(result);
          // console.log(util.inspect(result, false, null));
          release.id = manifestData["RDF"]["Description"]
            .map((Description: any) => {
              // console.log(Description);
              if (Description["about"] == "urn:mozilla:install-manifest") {
                return Description["em:id"][0];
              }
            })
            .filter((id: string | undefined) => id !== undefined)[0];
        }
      );
      // 从 install.rdf 中获取 description
      plugin.description =
        plugin.description ??
        (fileData.match(/em:description="(.*?)"/) ??
          fileData.match(/<em:description>(.*?)<\/em:description>/) ?? [
            "",
            "NO desc",
          ])[1];

      plugin.name =
        plugin.name ||
        (fileData.match(/em:name="(.*?)"/) ??
          fileData.match(/<em:name>(.*?)<\/em:name>/) ?? ["", "No Name"])[1];

      release.xpiVersion = (fileData.match(/em:version="(.*?)"/) ??
        fileData.match(/<em:version>(.*?)<\/em:version>/) ?? ["", ""])[1];
    }
  }
  console.info(`${plugin.name} 处理完成`);
  return plugin;
}
