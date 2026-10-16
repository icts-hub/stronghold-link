.pragma library

// 引语库：哲学 / 文学 / 诗歌。
//
// 选文口径（重要，别往里面塞"看着像名言"的句子）：
//   · 中文条目只收公版典籍原文，出处写到篇名；
//   · 西文条目是我自己按原意重译的短句，末尾标"译"，不抄任何有版权的现成译本；
//   · 每条都必须能指到作者与作品，宁可少，不凑数。
// 每条的关键字 key 用于收藏（存到 quotes.json），改动 key 等于让老收藏失效，
// 所以 key 用"作者-篇名-首句编号"的稳定写法，不要用数组下标。

var PHILOSOPHY = "哲学"
var LITERATURE = "文学"
var POETRY = "诗歌"

var QUOTES = [
    // ── 哲学 ────────────────────────────────────────────────────────────
    { key: "laozi-daodejing-01", kind: PHILOSOPHY, who: "老子", work: "《道德经》",
      text: "知人者智，自知者明。胜人者有力，自胜者强。" },
    { key: "laozi-daodejing-02", kind: PHILOSOPHY, who: "老子", work: "《道德经》",
      text: "天下难事，必作于易；天下大事，必作于细。" },
    { key: "kongzi-lunyu-01", kind: PHILOSOPHY, who: "孔子", work: "《论语·雍也》",
      text: "知之者不如好之者，好之者不如乐之者。" },
    { key: "kongzi-lunyu-02", kind: PHILOSOPHY, who: "孔子", work: "《论语·卫灵公》",
      text: "君子求诸己，小人求诸人。" },
    { key: "zhuangzi-qiwulun-01", kind: PHILOSOPHY, who: "庄子", work: "《庄子·齐物论》",
      text: "天地与我并生，而万物与我为一。" },
    { key: "mengzi-jinxin-01", kind: PHILOSOPHY, who: "孟子", work: "《孟子·尽心上》",
      text: "万物皆备于我矣。反身而诚，乐莫大焉。" },
    { key: "wangyangming-chuanxilu-01", kind: PHILOSOPHY, who: "王阳明", work: "《传习录》",
      text: "心外无物，心外无理。" },
    { key: "socrates-apology-01", kind: PHILOSOPHY, who: "苏格拉底", work: "《申辩篇》（译）",
      text: "未经省察的人生，是不值得过的。" },
    { key: "aristotle-metaphysics-01", kind: PHILOSOPHY, who: "亚里士多德", work: "《形而上学》（译）",
      text: "求知是人类的本性。" },
    { key: "marcus-meditations-01", kind: PHILOSOPHY, who: "马可·奥勒留", work: "《沉思录》（译）",
      text: "人能失去的只有此刻——因为人只拥有此刻。" },
    { key: "spinoza-politica-01", kind: PHILOSOPHY, who: "斯宾诺莎", work: "《政治论》（译）",
      text: "不嘲笑，不哀叹，不诅咒，只求理解。" },
    { key: "kant-practicalreason-01", kind: PHILOSOPHY, who: "康德", work: "《实践理性批判》（译）",
      text: "有两样东西愈是反复思索，愈是令人敬畏：头顶的星空，与心中的道德律。" },
    { key: "nietzsche-twilight-01", kind: PHILOSOPHY, who: "尼采", work: "《偶像的黄昏》（译）",
      text: "凡不能杀死我的，必使我更强大。" },
    { key: "wittgenstein-tractatus-01", kind: PHILOSOPHY, who: "维特根斯坦", work: "《逻辑哲学论》（译）",
      text: "凡不可说的，必须保持沉默。" },
    { key: "camus-sisyphus-01", kind: PHILOSOPHY, who: "加缪", work: "《西西弗神话》（译）",
      text: "必须想象西西弗是幸福的。" },

    // ── 文学 ────────────────────────────────────────────────────────────
    { key: "simaqian-baorenanshu-01", kind: LITERATURE, who: "司马迁", work: "《报任安书》",
      text: "人固有一死，或重于泰山，或轻于鸿毛。" },
    { key: "taoyuanming-guiqulai-01", kind: LITERATURE, who: "陶渊明", work: "《归去来兮辞》",
      text: "悟已往之不谏，知来者之可追。" },
    { key: "wangbo-tengwangge-01", kind: LITERATURE, who: "王勃", work: "《滕王阁序》",
      text: "落霞与孤鹜齐飞，秋水共长天一色。" },
    { key: "fanzhongyan-yueyanglou-01", kind: LITERATURE, who: "范仲淹", work: "《岳阳楼记》",
      text: "不以物喜，不以己悲。" },
    { key: "guiyouguang-xiangjixuan-01", kind: LITERATURE, who: "归有光", work: "《项脊轩志》",
      text: "庭有枇杷树，吾妻死之年所手植也，今已亭亭如盖矣。" },
    { key: "zhangdai-huxinting-01", kind: LITERATURE, who: "张岱", work: "《湖心亭看雪》",
      text: "天与云与山与水，上下一白。" },
    { key: "shenfu-fushengliuji-01", kind: LITERATURE, who: "沈复", work: "《浮生六记》",
      text: "情之所钟，虽丑不嫌。" },
    { key: "luxun-guxiang-01", kind: LITERATURE, who: "鲁迅", work: "《故乡》",
      text: "其实地上本没有路，走的人多了，也便成了路。" },
    { key: "sushi-chibifu-01", kind: LITERATURE, who: "苏轼", work: "《前赤壁赋》",
      text: "纵一苇之所如，凌万顷之茫然。" },
    { key: "limi-chenqingbiao-01", kind: LITERATURE, who: "李密", work: "《陈情表》",
      text: "茕茕孑立，形影相吊。" },
    { key: "saint-exupery-littleprince-01", kind: LITERATURE, who: "圣埃克苏佩里", work: "《小王子》（译）",
      text: "真正重要的东西，用眼睛是看不见的。" },
    { key: "rilke-letters-01", kind: LITERATURE, who: "里尔克", work: "《给青年诗人的信》（译）",
      text: "请对你心中所有未解的疑惑保持耐心，试着去爱这些问题本身。" },

    // ── 诗歌 ────────────────────────────────────────────────────────────
    { key: "quyuan-lisao-01", kind: POETRY, who: "屈原", work: "《离骚》",
      text: "路漫漫其修远兮，吾将上下而求索。" },
    { key: "taoyuanming-yinjiu-01", kind: POETRY, who: "陶渊明", work: "《饮酒·其五》",
      text: "采菊东篱下，悠然见南山。" },
    { key: "libai-jiangjinjiu-01", kind: POETRY, who: "李白", work: "《将进酒》",
      text: "君不见黄河之水天上来，奔流到海不复回。" },
    { key: "dufu-chunwang-01", kind: POETRY, who: "杜甫", work: "《春望》",
      text: "国破山河在，城春草木深。" },
    { key: "wangwei-zhongnanbiesye-01", kind: POETRY, who: "王维", work: "《终南别业》",
      text: "行到水穷处，坐看云起时。" },
    { key: "sushi-dingfengbo-01", kind: POETRY, who: "苏轼", work: "《定风波》",
      text: "回首向来萧瑟处，归去，也无风雨也无晴。" },
    { key: "liushangyin-yixiang-01", kind: POETRY, who: "李商隐", work: "《无题》",
      text: "身无彩凤双飞翼，心有灵犀一点通。" },
    { key: "wangzhihuan-guanquelou-01", kind: POETRY, who: "王之涣", work: "《登鹳雀楼》",
      text: "欲穷千里目，更上一层楼。" },
    { key: "tagore-straybirds-01", kind: POETRY, who: "泰戈尔", work: "《飞鸟集》（译）",
      text: "如果你因错过太阳而流泪，那么你也将错过群星。" },
    { key: "basho-frog-01", kind: POETRY, who: "松尾芭蕉", work: "俳句（译）",
      text: "古池塘，青蛙跃入，水声。" },
    { key: "yeats-whenyouareold-01", kind: POETRY, who: "叶芝", work: "《当你老了》（译）",
      text: "多少人爱你青春欢畅的时辰，唯有一人爱你朝圣者的灵魂。" },
    { key: "eliot-fourquartets-01", kind: POETRY, who: "艾略特", work: "《四个四重奏》（译）",
      text: "我们不应停止探索，而一切探索的终点，是回到起点，并第一次认识它。" }
]

function count() {
    return QUOTES.length
}

// 环形取用：越界自动绕回，上一条/下一条都能一直按。
function at(index) {
    if (QUOTES.length === 0) return null
    var n = QUOTES.length
    return QUOTES[((index % n) + n) % n]
}

// 按 key 找下标；找不到返回 -1（收藏列表里可能留着已经删掉的条目）。
function indexOf(key) {
    for (var i = 0; i < QUOTES.length; i++) {
        if (QUOTES[i].key === key) return i
    }
    return -1
}

function kinds() {
    return [PHILOSOPHY, LITERATURE, POETRY]
}
