#include <QFile>
#include <QFontDatabase>
#include <QGuiApplication>
#include <QImage>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickWindow>
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
        }
    }

    if (!sizeSpec.isEmpty()) {
        const QStringList parts = sizeSpec.split(QLatin1Char('x'), Qt::SkipEmptyParts);
        if (parts.size() == 2) {
            width = qMax(640, parts.at(0).trimmed().toInt());
            height = qMax(480, parts.at(1).trimmed().toInt());
        }
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
    engine.rootContext()->setContextProperty(QStringLiteral("cycleIntervalMs"), cycleMs);
    engine.rootContext()->setContextProperty(QStringLiteral("cycleLimit"), cycleCount);
    engine.rootContext()->setContextProperty(QStringLiteral("sessionStartDelayMs"), sessionStartMs);
    engine.rootContext()->setContextProperty(QStringLiteral("sessionStopDelayMs"), sessionStopMs);
    engine.rootContext()->setContextProperty(QStringLiteral("autoSession"), sessionStartMs > 0 || sessionStopMs > 0);
    engine.load(QUrl(QStringLiteral("qrc:/qml/Main.qml")));
    qInfo("startup: platform=%s qmlWarnings=%d page=%s size=%dx%d",
          qPrintable(QGuiApplication::platformName()),
          int(engine.rootObjects().isEmpty()),
          qPrintable(pageKey.isEmpty() ? QStringLiteral("session") : pageKey),
          width,
          height);
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

    const int rc = app.exec();
    qInfo("exit: rc=%d", rc);
    bridge.stop();
    return rc;
}
