#include <QDir>
#include <QFile>
#include <QFontDatabase>
#include <QGuiApplication>
#include <QImage>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickItem>
#include <QQuickWindow>
#include <QScreen>
#include <QStringList>
#include <QTextStream>
#include <QTimer>
#include <QtGlobal>

#include "backendbridge.h"

// 诊断日志：windows 子系统进程没有控制台，--log <file> 把 qDebug/qWarning/qCritical
// 全部写文件，抓图/启动失败时有据可查（也是 QML 运行期错误唯一的落点）。
static QFile *g_logFile = nullptr;

static void shlMessageHandler(QtMsgType type, const QMessageLogContext &, const QString &msg)
{
    const char *tag = "info";
    switch (type) {
    case QtDebugMsg: tag = "debug"; break;
    case QtInfoMsg: tag = "info"; break;
    case QtWarningMsg: tag = "warn"; break;
    case QtCriticalMsg: tag = "critical"; break;
    case QtFatalMsg: tag = "fatal"; break;
    }
    const QString line = QStringLiteral("[%1] %2").arg(QLatin1String(tag), msg);
    if (g_logFile) {
        g_logFile->write(line.toUtf8());
        g_logFile->write("\n");
        g_logFile->flush();
    }
    fprintf(stderr, "%s\n", qPrintable(line));
    fflush(stderr);
}

// 在 QGuiApplication 之前扫一遍原始 argv：平台插件加载期的报错也要能落盘。
static QString scanArg(int argc, char *argv[], const char *key)
{
    for (int i = 1; i + 1 < argc; ++i) {
        if (qstrcmp(argv[i], key) == 0)
            return QString::fromLocal8Bit(argv[i + 1]);
    }
    return QString();
}

// 命令行参数（只用于开发/验收，正常启动不需要任何参数）：
//   --page <session|friends|setting>  初始页面
//   --size <WxH>                      初始窗口尺寸（截图验收用 1440x900 / 1280x720 / 1024x768）
//   --grab <out.png>                  渲染完成后抓窗口存 PNG 并退出
//   --delay <ms>                      抓图前等待时间（默认 3000，留给后端握手与 Canvas 首帧）
//   --gpu                             抓图时也用默认图形后端（默认软件渲染，避免无 GPU 会话抓出黑图）
//   --cycle <ms> / --cycles <n>       内存验收：每 ms 切一次页面，共切 n 次
//   --session-start <ms>              内存验收：启动 ms 毫秒后用当前表单默认值真的开一次会话
//   --session-stop <ms>               内存验收：启动 ms 毫秒后停掉会话（与上面配合量"开始/停止"的内存曲线）
int main(int argc, char *argv[])
{
    QFile logFile;
    const QString logPath = scanArg(argc, argv, "--log");
    if (!logPath.isEmpty()) {
        logFile.setFileName(logPath);
        if (logFile.open(QIODevice::WriteOnly | QIODevice::Truncate | QIODevice::Text)) {
            g_logFile = &logFile;
            qInstallMessageHandler(shlMessageHandler);
        }
    }

    // 验收诊断：--text native 关闭距离场字形缓存（Qt 默认用距离场渲染文字，字形图集
    // 是启动期的一块固定驻留）。必须在任何 QQuickWindow 之前设置，否则 QSGTextMask
    // 已经按默认模式建过材质、切不回原生字形。
    if (scanArg(argc, argv, "--text") == QLatin1String("native"))
        QQuickWindow::setTextRenderType(QQuickWindow::NativeTextRendering);

    // 高 DPI：不做取整（125% / 150% 缩放时按真实比例走）。默认策略会把缩放因子
    // 四舍五入到整数，2560x1440@125% 这类屏幕上窗口尺寸与字号都会跳一下。
    QGuiApplication::setHighDpiScaleFactorRoundingPolicy(Qt::HighDpiScaleFactorRoundingPolicy::PassThrough);

    QGuiApplication app(argc, argv);
    app.setApplicationName(QStringLiteral("Stronghold Link"));
    app.setApplicationDisplayName(QStringLiteral("Stronghold Link"));
    app.setOrganizationName(QStringLiteral("icts-hub"));
    // 版本号唯一来源是 package.json：后端 app.info 返回 bridge.version，QML 显示它。

    const QStringList args = app.arguments();
    QString grabPath;
    QString pageKey;
    QString sizeSpec;
    int width = 1440;
    int height = 900;
    int delayMs = 3000;
    bool allowGpu = false;
    int cycleMs = 0;      // >0：定期在三个页面间轮换，用于内存验收的"往返切换"场景
    int cycleCount = 0;   // >0：轮换到此次数后停止（0 表示一直轮换）
    int sessionStartMs = 0; // >0：等这么久后用表单当前默认值真的开一次会话（内存验收）
    int sessionStopMs = 0;  // >0：等这么久后停掉会话（内存验收）
    // 流动背景的相位（0~1）。给验收用：截图必须可复现，所以允许把动画钉在某一刻。
    double flowPhase = -1.0; // <0 表示按真实时间走
    QString flowLevel;       // 覆盖"装饰动效"档位（full / normal / minimal）
    // 流动背景的组成部分开关（位掩码 1=网点带 2=细流 4=扫光 8=星点，默认 15 全开）。
    // 这是排查用的：整层一起上会让进程崩，需要把四组元素分别关掉定位是哪一组。
    int flowParts = 15;
    // 强制"窗口模式"（1440x900 居中窗口，带自绘标题栏）。不给这个开关时，没有 --size
    // 的启动会铺满主屏可用区 —— 2560x1440 这类屏上原来只开 1440x900 一块，看起来就是
    // "分辨率不对"。
    bool forceWindowed = false;
    // 动效验收：把窗口连续截成一串帧（默认 40ms 一帧），用来拼 GIF / 逐帧核对动画。
    // 配合 --cycle <ms> 使用：切页那一刻的擦除、转场带、导航条橡皮筋都能被逐帧抓住。
    QString framesDir;
    int framesCount = 0;
    int framesIntervalMs = 40;
    // 引语卡片：验收截图时直接开着窗口起（命令行开关，正常运行不走这条路）
    bool openQuotes = false;
    // 性能实测：--perf <秒> 打开逐帧探针，结束时在日志里打印
    // 帧数 / 平均帧时间 / p95 / 最差一帧 / 等效 FPS（用于"性能可控"这条验收）。
    double perfSeconds = 0.0;
    bool sheetMode = false;

    for (int i = 1; i < args.size(); ++i) {
        const QString a = args.at(i);
        const auto takeNext = [&args, &i]() { return (i + 1 < args.size()) ? args.at(++i) : QString(); };
        if (a == QLatin1String("--page")) {
            pageKey = takeNext();
        } else if (a == QLatin1String("--size")) {
            sizeSpec = takeNext();
        } else if (a == QLatin1String("--grab")) {
            grabPath = takeNext();
        } else if (a == QLatin1String("--delay")) {
            delayMs = takeNext().toInt();
        } else if (a == QLatin1String("--frames")) {
            framesDir = takeNext();
        } else if (a == QLatin1String("--frames-count")) {
            framesCount = takeNext().toInt();
        } else if (a == QLatin1String("--frames-interval")) {
            framesIntervalMs = takeNext().toInt();
        } else if (a == QLatin1String("--gpu")) {
            allowGpu = true;
        } else if (a == QLatin1String("--cycle")) {
            cycleMs = takeNext().toInt();
        } else if (a == QLatin1String("--cycles")) {
            cycleCount = takeNext().toInt();
        } else if (a == QLatin1String("--session-start")) {
            sessionStartMs = takeNext().toInt();
        } else if (a == QLatin1String("--session-stop")) {
            sessionStopMs = takeNext().toInt();
        } else if (a == QLatin1String("--flow-phase")) {
            flowPhase = takeNext().toDouble();
        } else if (a == QLatin1String("--flow-level")) {
            flowLevel = takeNext();
        } else if (a == QLatin1String("--flow-parts")) {
            flowParts = takeNext().toInt();
        } else if (a == QLatin1String("--windowed")) {
            forceWindowed = true;
        } else if (a == QLatin1String("--open-quotes")) {
            openQuotes = true;
        } else if (a == QLatin1String("--perf")) {
            perfSeconds = takeNext().toDouble();
        } else if (a == QLatin1String("--sheet")) {
            // 纹样样张模式：窗口里并排铺开四种组合模板，配合 --grab 出设计验收图
            sheetMode = true;
        }
    }

    if (!sizeSpec.isEmpty()) {
        const QStringList parts = sizeSpec.split(QLatin1Char('x'), Qt::SkipEmptyParts);
        if (parts.size() == 2) {
            width = qMax(640, parts.at(0).trimmed().toInt());
            height = qMax(480, parts.at(1).trimmed().toInt());
        }
    }

    // 初始几何：给了 --size（验收截图）或 --windowed 就是居中窗口；否则铺满主屏可用区
    // （win 上"可用区"已经排除了任务栏 —— 无边框窗口不能靠 showMaximized 铺满，那样会
    // 盖住任务栏）。QML 侧 x/y/width/height 直接读这几个上下文属性。
    const QScreen *screen = QGuiApplication::primaryScreen();
    const QRect avail = screen ? screen->availableGeometry() : QRect(0, 0, 1440, 900);
    const bool windowed = forceWindowed || !sizeSpec.isEmpty();
    int posX = 0;
    int posY = 0;
    bool startMaximized = false;
    if (windowed) {
        posX = avail.x() + qMax(0, (avail.width() - width) / 2);
        posY = avail.y() + qMax(0, (avail.height() - height) / 2);
    } else {
        width = avail.width();
        height = avail.height();
        posX = avail.x();
        posY = avail.y();
        startMaximized = true;
    }

    if (!grabPath.isEmpty() && !allowGpu) {
        // 无 GPU / 远程桌面会话里默认后端可能抓出空图，验收截图走软件渲染。
        QQuickWindow::setGraphicsApi(QSGRendererInterface::Software);
    }

    BackendBridge bridge;

    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty(QStringLiteral("bridge"), &bridge);
    engine.rootContext()->setContextProperty(QStringLiteral("initialPage"), pageKey);
    engine.rootContext()->setContextProperty(QStringLiteral("initialWidth"), width);
    engine.rootContext()->setContextProperty(QStringLiteral("initialHeight"), height);
    engine.rootContext()->setContextProperty(QStringLiteral("initialX"), posX);
    engine.rootContext()->setContextProperty(QStringLiteral("initialY"), posY);
    engine.rootContext()->setContextProperty(QStringLiteral("initialMaximized"), startMaximized);
    engine.rootContext()->setContextProperty(QStringLiteral("screenAvailableWidth"), avail.width());
    engine.rootContext()->setContextProperty(QStringLiteral("screenAvailableHeight"), avail.height());
    engine.rootContext()->setContextProperty(QStringLiteral("cycleIntervalMs"), cycleMs);
    engine.rootContext()->setContextProperty(QStringLiteral("cycleLimit"), cycleCount);
    engine.rootContext()->setContextProperty(QStringLiteral("sessionStartDelayMs"), sessionStartMs);
    engine.rootContext()->setContextProperty(QStringLiteral("sessionStopDelayMs"), sessionStopMs);
    engine.rootContext()->setContextProperty(QStringLiteral("autoSession"), sessionStartMs > 0 || sessionStopMs > 0);
    // 流动背景：--flow-phase 把动画钉在某一相位（截图可复现）；--flow-level 覆盖动效档位。
    engine.rootContext()->setContextProperty(QStringLiteral("initialFlowPhase"), flowPhase);
    engine.rootContext()->setContextProperty(QStringLiteral("flowPhaseLocked"), flowPhase >= 0.0);
    engine.rootContext()->setContextProperty(QStringLiteral("flowLevelOverride"), flowLevel);
    engine.rootContext()->setContextProperty(QStringLiteral("flowPartsMask"), flowParts);
    engine.rootContext()->setContextProperty(QStringLiteral("initialQuoteOpen"), openQuotes);
    engine.rootContext()->setContextProperty(QStringLiteral("perfSeconds"), perfSeconds);
    engine.rootContext()->setContextProperty(QStringLiteral("sheetMode"), sheetMode);
    engine.load(QUrl(QStringLiteral("qrc:/qml/Main.qml")));
    qInfo("startup: platform=%s qmlWarnings=%d page=%s size=%dx%d windowed=%d",
          qPrintable(QGuiApplication::platformName()),
          int(engine.rootObjects().isEmpty()),
          qPrintable(pageKey.isEmpty() ? QStringLiteral("session") : pageKey),
          width,
          height,
          int(windowed));
    qInfo("startup: screen=%s available=%dx%d at %d,%d dpr=%.2f",
          qPrintable(screen ? screen->name() : QStringLiteral("(none)")),
          avail.width(),
          avail.height(),
          avail.x(),
          avail.y(),
          screen ? screen->devicePixelRatio() : 0.0);
    if (engine.rootObjects().isEmpty())
        return 1;

    QQuickWindow *window = qobject_cast<QQuickWindow *>(engine.rootObjects().constFirst());
    if (!window)
        qWarning("startup: root object is not a QQuickWindow");

    // 先把窗口画出来，再把后端拉起来：冷启动时界面先可见，不阻塞首帧。
    QTimer::singleShot(0, &bridge, &BackendBridge::start);

    if (!grabPath.isEmpty() && window) {
        QTimer::singleShot(delayMs, &app, [window, grabPath, &app]() {
            qInfo("grab: visible=%d exposed=%d size=%dx%d dpr=%.2f",
                  int(window->isVisible()),
                  int(window->isExposed()),
                  window->width(),
                  window->height(),
                  window->devicePixelRatio());
            // 布局体检：窗口内容项的尺寸与"建议最小尺寸"。网格布局在小窗口里会被裁掉右侧
            // （1024x768 验收截图暴露过这个问题），把两个尺寸都记下来便于按需缩放。
            if (QQuickItem *content = window->contentItem()) {
                qInfo("grab: content item=%dx%d implicit=%dx%d  overflowW=%d overflowH=%d",
                      int(content->width()), int(content->height()),
                      int(content->implicitWidth()), int(content->implicitHeight()),
                      int(content->implicitWidth() - window->width()),
                      int(content->implicitHeight() - window->height()));
                for (QQuickItem *child : content->childItems()) {
                    qInfo("grab:   child %s  %dx%d  implicit=%dx%d",
                          child->metaObject()->className(),
                          int(child->width()), int(child->height()),
                          int(child->implicitWidth()), int(child->implicitHeight()));
                }
            }
            window->requestUpdate();
            const QImage shot = window->grabWindow();
            const bool ok = !shot.isNull() && shot.save(grabPath, "PNG");
            if (ok)
                qInfo("grab: wrote %s (%dx%d)", qPrintable(grabPath), shot.width(), shot.height());
            else
                qWarning("grab: failed to write %s (image null=%d)", qPrintable(grabPath), int(shot.isNull()));
            app.exit(ok ? 0 : 2);
        });
    }

    // 动效逐帧验收：等 delayMs 之后开始连续截帧，每 framesIntervalMs 一帧，共 framesCount 帧。
    // 帧文件是 frame-0000.png 这样的定宽序号，按名字排序就是播放顺序。
    if (!framesDir.isEmpty() && framesCount > 0 && window) {
        QTimer::singleShot(delayMs, &app, [window, framesDir, framesCount, framesIntervalMs, &app]() {
            QDir().mkpath(framesDir);
            auto *ticker = new QTimer(&app);
            auto *taken = new int(0);
            QObject::connect(ticker, &QTimer::timeout, &app, [window, framesDir, framesCount, taken, ticker, &app]() {
                if (*taken >= framesCount) {
                    ticker->stop();
                    qInfo("frames: 共写出 %d 帧到 %s", *taken, qPrintable(framesDir));
                    app.exit(0);
                    return;
                }
                window->requestUpdate();
                const QImage shot = window->grabWindow();
                const QString path = QStringLiteral("%1/frame-%2.png")
                                         .arg(framesDir)
                                         .arg(*taken, 4, 10, QLatin1Char('0'));
                if (!shot.isNull() && shot.save(path, "PNG"))
                    *taken += 1;
                else
                    qWarning("frames: 第 %d 帧写失败", *taken);
            });
            ticker->start(framesIntervalMs);
        });
    }

    const int rc = app.exec();    qInfo("exit: rc=%d", rc);
    bridge.stop();
    return rc;
}
