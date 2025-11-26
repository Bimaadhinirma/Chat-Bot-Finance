const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const { MessageMedia } = require('whatsapp-web.js');

class ChartGenerator {
    constructor() {
        this.width = 800;
        this.height = 600;
        this.chartJSNodeCanvas = new ChartJSNodeCanvas({ 
            width: this.width, 
            height: this.height,
            backgroundColour: '#1a1a1a'
        });
    }

    /**
     * Generate pie chart untuk kategori pengeluaran
     */
    async generateExpensePieChart(categoryStats, totalIncome, totalExpense, periodLabel = 'Bulan Ini') {
        // Prepare data
        const labels = categoryStats.map(cat => {
            const categoryName = cat.category || 'Lainnya';
            return categoryName.charAt(0).toUpperCase() + categoryName.slice(1);
        });
        
        const data = categoryStats.map(cat => cat.total);
        const totalExpenseValue = data.reduce((sum, val) => sum + val, 0);
        
        // Calculate percentages
        const percentages = data.map(val => ((val / totalExpenseValue) * 100).toFixed(1));

        // Color palette (similar to the example image)
        const colors = [
            '#FF6B6B', // Red - Kebutuhan
            '#FFA07A', // Orange - Other
            '#FFD93D', // Yellow - Social Life
            '#95E1D3', // Teal - Food
            '#A8E6CF', // Light Green - Minyak
            '#DDA0DD', // Plum
            '#87CEEB', // Sky Blue
            '#FFB6C1', // Light Pink
            '#98D8C8', // Mint
            '#F7DC6F'  // Light Yellow
        ];

        const configuration = {
            type: 'pie',
            data: {
                labels: labels,
                datasets: [{
                    data: data,
                    backgroundColor: colors.slice(0, labels.length),
                    borderColor: '#1a1a1a',
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: {
                        display: true,
                        position: 'bottom',
                        labels: {
                            color: '#FFFFFF',
                            font: {
                                size: 14,
                                family: 'Arial'
                            },
                            padding: 15,
                            generateLabels: (chart) => {
                                const data = chart.data;
                                return data.labels.map((label, i) => ({
                                    text: `${label} (${percentages[i]}%)`,
                                    fillStyle: data.datasets[0].backgroundColor[i],
                                    hidden: false,
                                    index: i
                                }));
                            }
                        }
                    },
                    title: {
                        display: true,
                        text: `Pengeluaran ${periodLabel}`,
                        color: '#FFFFFF',
                        font: {
                            size: 20,
                            weight: 'bold',
                            family: 'Arial'
                        },
                        padding: {
                            top: 10,
                            bottom: 20
                        }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(0, 0, 0, 0.8)',
                        titleColor: '#FFFFFF',
                        bodyColor: '#FFFFFF',
                        borderColor: '#FFFFFF',
                        borderWidth: 1,
                        padding: 12,
                        displayColors: true,
                        callbacks: {
                            label: function(context) {
                                const label = context.label || '';
                                const value = context.parsed || 0;
                                const percentage = percentages[context.dataIndex];
                                return `${label}: Rp ${value.toLocaleString('id-ID')} (${percentage}%)`;
                            }
                        }
                    }
                }
            },
            plugins: [{
                id: 'customCanvasBackgroundColor',
                beforeDraw: (chart) => {
                    const ctx = chart.canvas.getContext('2d');
                    ctx.save();
                    ctx.globalCompositeOperation = 'destination-over';
                    ctx.fillStyle = '#1a1a1a';
                    ctx.fillRect(0, 0, chart.width, chart.height);
                    ctx.restore();
                }
            }]
        };

        const imageBuffer = await this.chartJSNodeCanvas.renderToBuffer(configuration);
        return imageBuffer;
    }

    /**
     * Generate chart dan convert ke MessageMedia untuk WhatsApp
     */
    async generateExpenseChartMedia(categoryStats, totalIncome, totalExpense, periodLabel = 'Bulan Ini') {
        try {
            const imageBuffer = await this.generateExpensePieChart(categoryStats, totalIncome, totalExpense, periodLabel);
            
            // Convert buffer to base64
            const base64Image = imageBuffer.toString('base64');
            
            // Create MessageMedia object
            const media = new MessageMedia('image/png', base64Image, 'expense-chart.png');
            
            return media;
        } catch (error) {
            console.error('❌ Error generating chart:', error);
            throw error;
        }
    }

    /**
     * Format currency untuk caption
     */
    formatCurrency(amount) {
        return new Intl.NumberFormat('id-ID', {
            style: 'currency',
            currency: 'IDR',
            minimumFractionDigits: 0
        }).format(amount);
    }

    /**
     * Generate caption untuk chart
     */
    generateCaption(categoryStats, totalIncome, totalExpense) {
        const totalExpenseValue = categoryStats.reduce((sum, cat) => sum + cat.total, 0);
        
        let caption = `📊 *Statistik Keuangan Bulan Ini*\n\n`;
        caption += `📈 Pemasukan: ${this.formatCurrency(totalIncome)}\n`;
        caption += `📉 Pengeluaran: ${this.formatCurrency(totalExpense)}\n`;
        caption += `💰 Saldo Bersih: ${this.formatCurrency(totalIncome - totalExpense)}\n\n`;
        
        caption += `🏷️ *Pengeluaran per Kategori:*\n`;
        
        categoryStats.forEach((cat, index) => {
            const categoryName = cat.category || 'Lainnya';
            const percentage = ((cat.total / totalExpenseValue) * 100).toFixed(1);
            const icon = this.getCategoryIcon(categoryName);
            caption += `${icon} ${categoryName.charAt(0).toUpperCase() + categoryName.slice(1)}: ${this.formatCurrency(cat.total)} (${percentage}%)\n`;
        });

        return caption;
    }

    /**
     * Get icon for category
     */
    getCategoryIcon(category) {
        const icons = {
            'kebutuhan': '🛒',
            'makanan': '🍔',
            'food': '🍔',
            'transportasi': '🚗',
            'hiburan': '🎮',
            'social life': '🎉',
            'minyak': '⛽',
            'tagihan': '📄',
            'kesehatan': '💊',
            'pendidikan': '📚',
            'lainnya': '📦',
            'other': '📦'
        };
        return icons[category.toLowerCase()] || '📦';
    }

    /**
     * Generate combo bar/line chart untuk trend bulanan
     */
    async generateMonthlyTrendsChart(monthlyData, totalIncome, totalExpense) {
        const months = Object.keys(monthlyData).sort();
        const incomeData = months.map(m => monthlyData[m].income);
        const expenseData = months.map(m => monthlyData[m].expense);
        const netData = months.map(m => monthlyData[m].income - monthlyData[m].expense);

        // Format month labels (e.g., "Jan 2025")
        const labels = months.map(m => {
            const [year, month] = m.split('-');
            const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
            return `${monthNames[parseInt(month) - 1]} ${year}`;
        });

        const configuration = {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Pemasukan',
                        data: incomeData,
                        backgroundColor: 'rgba(75, 192, 192, 0.6)',
                        borderColor: 'rgba(75, 192, 192, 1)',
                        borderWidth: 2,
                        type: 'bar'
                    },
                    {
                        label: 'Pengeluaran',
                        data: expenseData,
                        backgroundColor: 'rgba(255, 99, 132, 0.6)',
                        borderColor: 'rgba(255, 99, 132, 1)',
                        borderWidth: 2,
                        type: 'bar'
                    },
                    {
                        label: 'Net',
                        data: netData,
                        borderColor: 'rgba(255, 206, 86, 1)',
                        backgroundColor: 'rgba(255, 206, 86, 0.2)',
                        borderWidth: 3,
                        type: 'line',
                        fill: false,
                        tension: 0.4
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            color: '#FFFFFF',
                            callback: function(value) {
                                return 'Rp ' + (value / 1000000).toFixed(1) + 'jt';
                            }
                        },
                        grid: {
                            color: 'rgba(255, 255, 255, 0.1)'
                        }
                    },
                    x: {
                        ticks: {
                            color: '#FFFFFF'
                        },
                        grid: {
                            color: 'rgba(255, 255, 255, 0.1)'
                        }
                    }
                },
                plugins: {
                    legend: {
                        display: true,
                        position: 'bottom',
                        labels: {
                            color: '#FFFFFF',
                            font: {
                                size: 14,
                                family: 'Arial'
                            },
                            padding: 15
                        }
                    },
                    title: {
                        display: true,
                        text: 'Trend Pemasukan & Pengeluaran',
                        color: '#FFFFFF',
                        font: {
                            size: 20,
                            weight: 'bold',
                            family: 'Arial'
                        },
                        padding: {
                            top: 10,
                            bottom: 20
                        }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(0, 0, 0, 0.8)',
                        titleColor: '#FFFFFF',
                        bodyColor: '#FFFFFF',
                        borderColor: '#FFFFFF',
                        borderWidth: 1,
                        padding: 12,
                        displayColors: true,
                        callbacks: {
                            label: function(context) {
                                const label = context.dataset.label || '';
                                const value = context.parsed.y || 0;
                                return `${label}: Rp ${value.toLocaleString('id-ID')}`;
                            }
                        }
                    }
                }
            },
            plugins: [{
                id: 'customCanvasBackgroundColor',
                beforeDraw: (chart) => {
                    const ctx = chart.canvas.getContext('2d');
                    ctx.save();
                    ctx.globalCompositeOperation = 'destination-over';
                    ctx.fillStyle = '#1a1a1a';
                    ctx.fillRect(0, 0, chart.width, chart.height);
                    ctx.restore();
                }
            }]
        };

        const imageBuffer = await this.chartJSNodeCanvas.renderToBuffer(configuration);
        return imageBuffer;
    }

    /**
     * Generate monthly trends chart media
     */
    async generateMonthlyTrendsChartMedia(monthlyData, totalIncome, totalExpense) {
        try {
            const imageBuffer = await this.generateMonthlyTrendsChart(monthlyData, totalIncome, totalExpense);
            
            const base64Image = imageBuffer.toString('base64');
            const media = new MessageMedia('image/png', base64Image, 'monthly-trends.png');
            
            return media;
        } catch (error) {
            console.error('❌ Error generating trends chart:', error);
            throw error;
        }
    }

    /**
     * Generate caption for monthly trends
     */
    generateTrendsCaption(monthlyData, totalIncome, totalExpense, monthCount) {
        const months = Object.keys(monthlyData).sort();
        
        let caption = `📊 *Statistik ${monthCount} Bulan Terakhir*\n\n`;
        caption += `📈 Total Pemasukan: ${this.formatCurrency(totalIncome)}\n`;
        caption += `📉 Total Pengeluaran: ${this.formatCurrency(totalExpense)}\n`;
        caption += `💰 Net: ${this.formatCurrency(totalIncome - totalExpense)}\n\n`;
        
        caption += `📅 *Periode:* ${months[0]} s/d ${months[months.length - 1]}\n`;
        caption += `📊 *Jumlah Bulan:* ${monthCount} bulan\n\n`;
        
        // Average per month
        const avgIncome = totalIncome / monthCount;
        const avgExpense = totalExpense / monthCount;
        caption += `📊 *Rata-rata per Bulan:*\n`;
        caption += `  • Pemasukan: ${this.formatCurrency(avgIncome)}\n`;
        caption += `  • Pengeluaran: ${this.formatCurrency(avgExpense)}\n`;
        
        return caption;
    }
}

module.exports = new ChartGenerator();
