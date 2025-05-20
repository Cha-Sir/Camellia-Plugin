import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url'; // 用于处理 ES Module 下的 __dirname

// logger 是 Yunzai-Bot 全局提供的日志对象
if (!global.logger) {
    // 如果在非Yunzai环境下或测试时，提供一个简单的logger兼容
    global.logger = {
        info: console.log,
        warn: console.warn,
        error: console.error,
        debug: console.log,
        red: (text) => text, // 简单实现，Yunzai的logger.red会改变颜色
        green: (text) => text,
    };
}

logger.info('---------~\OvO/~---------');
logger.info('冒险游戏插件 [adventureGame] 开始加载...');

// 获取当前文件的目录路径 (ES Module 兼容)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const appsPath = path.join(__dirname, 'apps'); // apps 目录的绝对路径
const apps = {};

if (fs.existsSync(appsPath)) {
    const files = fs.readdirSync(appsPath).filter(file => file.endsWith('.js'));

    for (const file of files) {
        const filePath = path.join(appsPath, file);
        try {
            // 动态导入 apps 目录下的 JS 文件
            // 注意：import() 返回一个 Promise，所以这里使用 await
            // `file://${filePath}` 确保在 Windows 和 POSIX 系统上都能正确解析路径
            const module = await import(`file://${filePath}`);

            // 假设我们的主插件类 AdventureGame 是在 adventureGameApp.js 中默认导出的
            // 或者通过具名导出的，例如 export class AdventureGame {}
            // 我们需要将这个类添加到 apps 对象中，Yunzai 会自动实例化并注册它
            if (module.AdventureGame && typeof module.AdventureGame === 'function') {
                // 如果是 export class AdventureGame
                // Yunzai 通常期望 apps 对象的值是插件类本身，而不是实例
                // key 可以是文件名（不含.js），或者自定义的更有意义的名称
                const appName = file.replace(/\.js$/, ''); // 移除 .js 后缀
                apps[appName] = module.AdventureGame;
                logger.info(`[adventureGame] 已加载应用: ${logger.green(appName)} from ${file}`);
            } else if (module.default && typeof module.default === 'function') {
                // 如果是 export default class AdventureGame
                const appName = file.replace(/\.js$/, '');
                apps[appName] = module.default;
                logger.info(`[adventureGame] 已加载默认导出应用: ${logger.green(appName)} from ${file}`);
            } else {
                logger.warn(`[adventureGame] 文件 ${file} 未能正确导出插件类。`);
            }
        } catch (e) {
            logger.error(`[adventureGame] 加载应用文件 ${logger.red(file)} 失败:`);
            logger.error(e);
        }
    }
} else {
    logger.warn(`[adventureGame] critical: 'apps' 目录 (${appsPath}) 未找到，插件可能无法正常工作。`);
}

if (Object.keys(apps).length === 0) {
    logger.warn('[adventureGame] 未加载任何应用，请检查 apps 目录及文件导出。');
} else {
    logger.info(`[adventureGame] 插件加载完成，共加载 ${Object.keys(apps).length} 个应用。`);
}
logger.info('-------------------------');

// 导出 apps 对象，Yunzai-Bot 会处理这里导出的所有插件类
export { apps };
